import { NextRequest } from "next/server";
import { db } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import { tlsTalos, tlsCommerceServices, tlsCommerceJobs, tlsRevenues } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveTalosFromRequest, verifyAgentApiKey } from "@/lib/auth";
import { verifyX402Payment, settleX402Payment } from "@/lib/stellar-x402";
import { fulfillInstant } from "@/lib/fulfillment";
import { registerServiceSchema, submitBidSchema, parseBody } from "@/lib/schemas";
import { withTraceContext } from "@/lib/tracing";
import { logger } from "@/lib/logger";

const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const IDEMPOTENCY_KEY_MAX_BYTES = 128;

/** Build a JSON response with standard idempotency echo headers. */
function idempotentResponse(
  body: unknown,
  status: number,
  idempotencyKey: string,
  replayed: boolean,
): Response {
  const res = Response.json(body, { status });
  res.headers.set("Idempotency-Key", idempotencyKey);
  res.headers.set("X-Idempotent-Replayed", String(replayed));
  return res;
}

// GET /api/talos/:id/service — Returns 402 with payment details (x402 storefront)
async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [service, talos] = await Promise.all([
      db
        .select()
        .from(tlsCommerceServices)
        .where(eq(tlsCommerceServices.talosId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ agentWalletAddress: tlsTalos.agentWalletAddress })
        .from(tlsTalos)
        .where(eq(tlsTalos.id, id))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

    if (!service) {
      return Response.json({ error: "No service registered for this TALOS" }, { status: 404 });
    }

    // payee: use service stellarPublicKey if set, otherwise fall back to agent wallet
    const payee = service.stellarPublicKey || talos?.agentWalletAddress;
    if (!payee) {
      return Response.json({ error: "No payment address configured for this TALOS" }, { status: 500 });
    }

    // Return 402 Payment Required with x402 Stellar payment details
    return Response.json(
      {
        price: Number(service.price),
        currency: service.currency,
        payee,
        chains: service.chains,
        network: STELLAR_NETWORK,
        assetCode: "USDC",
        serviceName: service.serviceName,
        description: service.description,
        fulfillmentMode: service.fulfillmentMode,
        talosId: id,
      },
      { status: 402 }
    );
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/service — Submit x402 payment + create commerce job
async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // 1. Authenticate requester TALOS via API key (scoped or legacy)
    // The URL param `id` identifies the service *provider*; the Bearer token
    // identifies the *requester* (buyer). resolveTalosFromRequest resolves the
    // caller from their key without requiring a known talosId.
    const auth = await resolveTalosFromRequest(request, ["commerce:write"]);
    if (!auth.ok) return auth.response;
    const requester = { id: auth.talos.id };

    // 1b. Read optional idempotency key from the request header.
    // Trim whitespace; treat an empty string as absent.
    const rawKey = request.headers.get("Idempotency-Key")?.trim() || null;
    if (rawKey !== null) {
      const byteLength = Buffer.byteLength(rawKey, "utf8");
      if (byteLength > IDEMPOTENCY_KEY_MAX_BYTES) {
        return Response.json(
          { error: `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_BYTES} bytes` },
          { status: 400 },
        );
      }
    }
    const idempotencyKey = rawKey;

    // 1c. Read body once (request body can only be consumed once)
    const requestBody = await request.json().catch(() => ({})) as Record<string, unknown>;

    // 1c. Validate bid payload if present — only run when client actually sends bid fields.
    // If bid fields are present but invalid, reject with 400 (never silently fall through).
    type BidData = { bidPrice?: number; status?: "negotiating" | "counter_offer" };
    let bidData: BidData = {};

    const hasBidFields = "bidPrice" in requestBody || "status" in requestBody;
    if (hasBidFields) {
      const bidValidation = submitBidSchema.safeParse(requestBody);
      if (!bidValidation.success) {
        const issues = bidValidation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        return Response.json(
          { error: "Invalid bid payload", issues },
          { status: 400 }
        );
      }
      bidData = bidValidation.data;
    }

    // Extract the effective payload for idempotency comparison and job creation.
    const payload = (requestBody.payload ?? requestBody) as Record<string, unknown>;

    // 2. Validate X-PAYMENT header (Stellar x402 token)
    const paymentHeader = request.headers.get("x-payment");
    if (!paymentHeader) {
      return Response.json(
        { error: "Missing X-PAYMENT header with Stellar x402 payment token" },
        { status: 400 }
      );
    }

    // Strip "x402 " prefix if present
    const paymentToken = paymentHeader.startsWith("x402 ")
      ? paymentHeader.slice(5).trim()
      : paymentHeader.trim();

    const [service, providerTalos] = await Promise.all([
      db
        .select()
        .from(tlsCommerceServices)
        .where(eq(tlsCommerceServices.talosId, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ agentWalletAddress: tlsTalos.agentWalletAddress })
        .from(tlsTalos)
        .where(eq(tlsTalos.id, id))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

    if (!service) {
      return Response.json({ error: "No service registered for this TALOS" }, { status: 404 });
    }

    const expectedPayee = service.stellarPublicKey || providerTalos?.agentWalletAddress;
    if (!expectedPayee) {
      return Response.json(
        { error: "No payment address configured for this TALOS" },
        { status: 500 }
      );
    }

    // 3. Idempotency check — if a key was supplied, look it up before any
    //    payment work.  Scoped per (talosId, requesterTalosId, idempotencyKey)
    //    so the same key is safe to reuse across different buyers.
    if (idempotencyKey) {
      const existing = await db
        .select()
        .from(tlsCommerceJobs)
        .where(
          and(
            eq(tlsCommerceJobs.talosId, id),
            eq(tlsCommerceJobs.requesterTalosId, requester.id),
            eq(tlsCommerceJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then((r) => r[0] ?? null);

      if (existing) {
        // Payload conflict check: same key must carry the same payload
        // contents to be considered equivalent.  Different payload →
        // reject to prevent silent mis-billing.
        const incomingPayloadJson = JSON.stringify(payload ?? {});
        const storedPayloadJson = JSON.stringify(existing.payload ?? {});
        if (incomingPayloadJson !== storedPayloadJson) {
          logger.warn({
            event: "idempotency_conflict",
            idempotencyKey,
            talosId: id,
            requesterTalosId: requester.id,
          }, "service purchase idempotency key reused with different payload");
          return Response.json(
            {
              error:
                "Idempotency-Key reused with a different payload. " +
                "Use a new key for a different request.",
            },
            { status: 409 },
          );
        }

        // Equivalent retry — return the original response from cache.
        if (existing.idempotencyResponse) {
          logger.info({
            event: "idempotency_hit",
            idempotencyKey,
            talosId: id,
            jobId: existing.id,
            replayed: true,
          }, "service purchase idempotent replay — returning cached response");
          return idempotentResponse(existing.idempotencyResponse, 201, idempotencyKey, true);
        }

        // Key exists but no cached response yet (edge case: concurrent first
        // request still in flight).  Treat as a duplicate in progress.
        logger.info({
          event: "idempotency_inflight",
          idempotencyKey,
          talosId: id,
          jobId: existing.id,
        }, "service purchase idempotent request in flight");
        return Response.json(
          { error: "Request with this Idempotency-Key is already being processed" },
          { status: 409 },
        );
      }

      logger.info({
        event: "idempotency_miss",
        idempotencyKey,
        talosId: id,
        requesterTalosId: requester.id,
      }, "new service purchase idempotent request");
    }

    // 4. Replay prevention — check payment token against existing jobs
    const existingJob = await db
      .select({ id: tlsCommerceJobs.id })
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.paymentSig, paymentToken))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existingJob) {
      return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
    }

    // Always verify against the listed service price — bidPrice is stored for negotiation
    // records only and must not reduce the payment amount until server-side accepted.
    const expectedAmount = Number(service.price).toFixed(2);
    const verified = await verifyX402Payment(paymentToken, expectedAmount, expectedPayee);
    if (!verified) {
      return Response.json(
        { error: "Invalid or insufficient x402 payment" },
        { status: 402 }
      );
    }

    // 5. Settle x402 payment on-chain (submits Soroban tx via facilitator)
    let txHash: string;
    try {
      const result = await settleX402Payment(paymentToken);
      txHash = result.txHash;
    } catch (settleErr) {
      console.error("Stellar x402 settlement failed:", settleErr);
      return Response.json(
        { error: "On-chain payment settlement failed" },
        { status: 502 }
      );
    }

    // 7. Create commerce job + fulfill

    if (service.fulfillmentMode === "instant") {
      // Instant mode: server calls external API and returns result synchronously
      let result: Record<string, unknown>;
      try {
        result = await fulfillInstant(service.serviceName, payload ?? {});
      } catch (fulfillErr) {
        console.error("Service fulfillment failed:", fulfillErr);
        return Response.json(
          { error: "Service fulfillment failed" },
          { status: 502 }
        );
      }

      // Build the response body (jobId filled in after insert).
      const responseBody = {
        jobId: "",
        status: bidData.status ?? "completed",
        result,
        txHash,
      };

      // Atomic: job + revenue + idempotency cache recorded together — if either
      // fails, all roll back.  Payment (on-chain) already happened; DB must not
      // partially record it.
      try {
        const [job] = await withTransactionRetry(
          async (tx) => {
            const [job] = await tx
              .insert(tlsCommerceJobs)
              .values({
                talosId: id,
                requesterTalosId: requester.id,
                serviceName: service.serviceName,
                payload: payload ?? undefined,
                result,
                paymentSig: paymentToken,
                txHash,
                amount: service.price,
                bidPrice: bidData.bidPrice ? String(bidData.bidPrice) : undefined,
                status: bidData.status ?? "completed",
                ...(idempotencyKey ? { idempotencyKey } : {}),
              })
              .returning();

            await tx.insert(tlsRevenues).values({
              talosId: id,
              amount: service.price,
              currency: service.currency ?? "USDC",
              source: "commerce",
              txHash,
            });

            // Cache the response body for future idempotent replays.
            if (idempotencyKey) {
              const finalResponse = { ...responseBody, jobId: job.id };
              await tx
                .update(tlsCommerceJobs)
                .set({ idempotencyResponse: finalResponse })
                .where(eq(tlsCommerceJobs.id, job.id));
            }

            return [job];
          },
          { category: "JOB" }
        );

        const finalBody = { ...responseBody, jobId: job.id };
        if (idempotencyKey) {
          return idempotentResponse(finalBody, 201, idempotencyKey, false);
        }
        return Response.json(finalBody, { status: 201 });
      } catch (err: unknown) {
        const e = err as Record<string, unknown>;
        if (e?.code === "23505") {
          const constraint = String(e?.constraint ?? e?.detail ?? "");
          if (constraint.includes("idempotencyKey")) {
            // Concurrent request with same idempotency key already inserted.
            // Fetch the cached response from that row.
            const existing = await db
              .select({ idempotencyResponse: tlsCommerceJobs.idempotencyResponse })
              .from(tlsCommerceJobs)
              .where(
                and(
                  eq(tlsCommerceJobs.talosId, id),
                  eq(tlsCommerceJobs.requesterTalosId, requester.id),
                  eq(tlsCommerceJobs.idempotencyKey, idempotencyKey!),
                ),
              )
              .limit(1)
              .then((r) => r[0] ?? null);

            if (existing?.idempotencyResponse) {
              return idempotentResponse(existing.idempotencyResponse, 201, idempotencyKey!, true);
            }
            return Response.json(
              { error: "Request with this Idempotency-Key is already being processed" },
              { status: 409 },
            );
          }
          if (constraint.includes("paymentSig")) {
            return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
          }
        }
        throw err;
      }
    }

    // Async mode: create pending job for agent to fulfill via polling.
    // Revenue is recorded when the job is fulfilled, not on creation.
    const responseBody = {
      jobId: "",
      status: bidData.status ?? "pending",
      txHash,
    };

    try {
      // Atomic: the job insert and the idempotency cache write must commit
      // together.  If the cache update fails, the job insert rolls back too,
      // otherwise the row would be left without a cached response and every
      // retry would receive a permanent 409.  Async mode records revenue on
      // fulfillment, so no revenue row is written here.
      const [job] = await withTransactionRetry(
        async (tx) => {
          const [job] = await tx
            .insert(tlsCommerceJobs)
            .values({
              talosId: id,
              requesterTalosId: requester.id,
              serviceName: service.serviceName,
              payload: payload ?? undefined,
              paymentSig: paymentToken,
              txHash,
              amount: service.price,
              bidPrice: bidData.bidPrice ? String(bidData.bidPrice) : undefined,
              status: bidData.status ?? "pending",
              ...(idempotencyKey ? { idempotencyKey } : {}),
            })
            .returning();

          // Cache the response body for future idempotent replays, in the
          // same transaction as the job insert.
          if (idempotencyKey) {
            const finalResponse = { ...responseBody, jobId: job.id };
            await tx
              .update(tlsCommerceJobs)
              .set({ idempotencyResponse: finalResponse })
              .where(eq(tlsCommerceJobs.id, job.id));
          }

          return [job];
        },
        { category: "JOB" }
      );

      const finalBody = { ...responseBody, jobId: job.id };
      if (idempotencyKey) {
        return idempotentResponse(finalBody, 201, idempotencyKey, false);
      }
      return Response.json(finalBody, { status: 201 });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      if (e?.code === "23505") {
        const constraint = String(e?.constraint ?? e?.detail ?? "");
        if (constraint.includes("idempotencyKey")) {
          const existing = await db
            .select({ idempotencyResponse: tlsCommerceJobs.idempotencyResponse })
            .from(tlsCommerceJobs)
            .where(
              and(
                eq(tlsCommerceJobs.talosId, id),
                eq(tlsCommerceJobs.requesterTalosId, requester.id),
                eq(tlsCommerceJobs.idempotencyKey, idempotencyKey!),
              ),
            )
            .limit(1)
            .then((r) => r[0] ?? null);

          if (existing?.idempotencyResponse) {
            return idempotentResponse(existing.idempotencyResponse, 201, idempotencyKey!, true);
          }
          return Response.json(
            { error: "Request with this Idempotency-Key is already being processed" },
            { status: 409 },
          );
        }
        if (constraint.includes("paymentSig")) {
          return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
        }
      }
      throw err;
    }
  } catch (err: unknown) {
    console.error("Service POST error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/talos/:id/service — Register or update commerce service (upsert)
async function handlePut(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["commerce:write"]);
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request, registerServiceSchema);
    if (parsed.error) return parsed.error;

    const { serviceName, description, price, stellarPublicKey, chains, fulfillmentMode } = parsed.data;

    // Get agent wallet as fallback for stellarPublicKey
    const talos = await db
      .select({ agentWalletAddress: tlsTalos.agentWalletAddress })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    const servicePublicKey = stellarPublicKey || talos?.agentWalletAddress;
    if (!servicePublicKey) {
      return Response.json(
        { error: "stellarPublicKey is required (no agent wallet available as fallback)" },
        { status: 400 }
      );
    }

    // Check if service already exists for this TALOS
    const existing = await db
      .select({ id: tlsCommerceServices.id })
      .from(tlsCommerceServices)
      .where(eq(tlsCommerceServices.talosId, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing) {
      // Update existing service
      const [updated] = await db
        .update(tlsCommerceServices)
        .set({
          serviceName,
          description: description ?? null,
          price: String(price),
          stellarPublicKey: servicePublicKey,
          chains: chains ?? ["stellar"],
          fulfillmentMode: fulfillmentMode ?? "async",
        })
        .where(eq(tlsCommerceServices.talosId, id))
        .returning();
      return Response.json(updated);
    }

    // Create new service
    const [service] = await db
      .insert(tlsCommerceServices)
      .values({
        talosId: id,
        serviceName,
        description: description ?? null,
        price: String(price),
        stellarPublicKey: servicePublicKey,
        chains: chains ?? ["stellar"],
        fulfillmentMode: fulfillmentMode ?? "async",
      })
      .returning();

    return Response.json(service, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
export const POST = withTraceContext(handlePost);
export const PUT = withTraceContext(handlePut);
