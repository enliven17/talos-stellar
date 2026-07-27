import { NextRequest } from "next/server";
import { db } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import { tlsTalos, tlsCommerceServices, tlsCommerceJobs, tlsRevenues } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { fulfillInstant } from "@/lib/fulfillment";
import { OPERATOR_PUBLIC_KEY, USDC_ISSUER } from "@/lib/stellar-config";
import { ingestJobToLedger } from "@/lib/reputation-ledger";

/**
 * POST /api/talos/:id/jobs
 *
 * Human user (or agent) requests a service from a Talos.
 * Accepts either:
 *   - signedXdr: signed transaction XDR (server submits + verifies payment)
 *   - txHash: already-submitted tx hash (legacy; no server-side payment check)
 *
 * Body: { buyerPublicKey, signedXdr?, txHash?, payload? }
 *
 * Idempotency contract
 * ────────────────────
 * The caller may include an `Idempotency-Key` request header with any opaque
 * string value (UUID recommended, max 128 bytes).  The key is scoped per
 * talosId so the same value may be reused safely across different agents.
 *
 * Behaviour:
 *   No header supplied   → request is processed normally with no idempotency.
 *
 *   New key              → job is created and the response body is cached in
 *                          idempotencyResponse.  Status 201 returned.
 *                          Response includes:
 *                            Idempotency-Key: <key>
 *                            X-Idempotent-Replayed: false
 *
 *   Same key, equivalent payload (same serviceName + payload contents)
 *                        → original cached 201 response returned immediately.
 *                          No side effects are repeated.
 *                          Response includes:
 *                            Idempotency-Key: <key>
 *                            X-Idempotent-Replayed: true
 *
 *   Same key, different payload (serviceName or payload mismatch)
 *                        → 409 Conflict.  Conflicting reuse of an idempotency
 *                          key is rejected to prevent silent mis-billing.
 *
 *   Concurrent requests with the same key
 *                        → the second INSERT hits the partial unique index
 *                          (talosId, idempotencyKey WHERE NOT NULL) and
 *                          receives a 409 immediately — no duplicate job is
 *                          created.
 *
 * The key is stored in tls_commerce_jobs.idempotencyKey alongside the cached
 * response in idempotencyResponse.  Both columns are nullable so existing jobs
 * without a key are completely unaffected.
 */

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

async function submitAndVerifyPayment(
  signedXdr: string,
  expectedAmount: string,
  expectedRecipient: string,
): Promise<{ txHash: string }> {
  const { TransactionBuilder, Horizon, Networks, Asset } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server("https://horizon-testnet.stellar.org");
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  const result = await server.submitTransaction(tx);
  const txHash = result.hash;

  // Verify at least one operation is a USDC payment to the expected recipient
  const USDC_ISSUER_VAL = USDC_ISSUER;
  const usdc = new Asset("USDC", USDC_ISSUER_VAL);
  const ops = tx.operations as unknown as Array<{
    type: string;
    asset?: { code: string; issuer: string };
    destination?: string;
    amount?: string;
  }>;
  const valid = ops.some(
    (op) =>
      op.type === "payment" &&
      op.asset?.code === usdc.code &&
      op.asset?.issuer === usdc.issuer &&
      op.destination === expectedRecipient &&
      parseFloat(op.amount ?? "0") >= parseFloat(expectedAmount),
  );
  if (!valid) {
    throw new Error("Payment TX does not include required USDC payment to service recipient");
  }

  return { txHash };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { buyerPublicKey, signedXdr, txHash: legacyTxHash, payload } = body as {
      buyerPublicKey?: string;
      signedXdr?: string;
      txHash?: string;
      payload?: Record<string, unknown>;
    };

    if (!buyerPublicKey) {
      return Response.json({ error: "buyerPublicKey is required" }, { status: 400 });
    }
    if (!signedXdr && !legacyTxHash) {
      return Response.json({ error: "signedXdr (or txHash) is required" }, { status: 400 });
    }

    // Read optional idempotency key from the request header.
    // Trim whitespace; treat an empty string as absent.
    const rawKey = request.headers.get("Idempotency-Key")?.trim() || null;

    // Validate key length (prevent header-size abuse)
    if (rawKey !== null) {
      const byteLength = Buffer.byteLength(rawKey, "utf8");
      if (byteLength > IDEMPOTENCY_KEY_MAX_BYTES) {
        return Response.json(
          {
            error: `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_BYTES} bytes`,
          },
          { status: 400 },
        );
      }
    }

    const idempotencyKey = rawKey;

    const [service, talos] = await Promise.all([
      db.select().from(tlsCommerceServices).where(eq(tlsCommerceServices.talosId, id)).limit(1).then(r => r[0] ?? null),
      db.select({ id: tlsTalos.id, agentOnline: tlsTalos.agentOnline, status: tlsTalos.status, name: tlsTalos.name, agentWalletAddress: tlsTalos.agentWalletAddress })
        .from(tlsTalos).where(eq(tlsTalos.id, id)).limit(1).then(r => r[0] ?? null),
    ]);

    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });
    if (!service) return Response.json({ error: "This agent offers no services" }, { status: 404 });
    if (talos.status === "Paused") {
      return Response.json({ error: "This agent is paused and cannot accept new work" }, { status: 409 });
    }
    if (talos.status === "Retired") {
      return Response.json({ error: "This agent is retired and cannot accept new work" }, { status: 409 });
    }

    // ── Idempotency check ─────────────────────────────────────────────
    // If the caller supplied a key, look it up before doing any payment work.
    if (idempotencyKey) {
      const existing = await db
        .select()
        .from(tlsCommerceJobs)
        .where(
          and(
            eq(tlsCommerceJobs.talosId, id),
            eq(tlsCommerceJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1)
        .then(r => r[0] ?? null);

      if (existing) {
        // Payload conflict check: same key must carry the same serviceName and
        // payload contents to be considered equivalent.  Different payload →
        // reject to prevent silent mis-billing.
        const incomingPayloadJson = JSON.stringify(payload ?? {});
        const storedPayloadJson = JSON.stringify(existing.payload ?? {});
        if (
          existing.serviceName !== service.serviceName ||
          incomingPayloadJson !== storedPayloadJson
        ) {
          logger.warn({
            event: "idempotency_conflict",
            idempotencyKey,
            talosId: id,
            existingServiceName: existing.serviceName,
            incomingServiceName: service.serviceName,
          }, "idempotency key reused with different payload");

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
          }, "idempotent replay — returning cached response");

          return idempotentResponse(existing.idempotencyResponse, 201, idempotencyKey, true);
        }

        // Key exists but no cached response yet (edge case: concurrent first
        // request still in flight).  Treat as a duplicate in progress.
        logger.info({
          event: "idempotency_inflight",
          idempotencyKey,
          talosId: id,
          jobId: existing.id,
        }, "idempotent request in flight");

        return Response.json(
          { error: "Request with this Idempotency-Key is already being processed" },
          { status: 409 },
        );
      }

      // First time seeing this key
      logger.info({
        event: "idempotency_miss",
        idempotencyKey,
        talosId: id,
      }, "new idempotent request");
    }

    // Submit + verify payment if signedXdr provided; otherwise use legacy txHash
    // Check quota before doing expensive payment work.
    const quotaResult = await checkAndIncrementQuota(db, id, "job_writes");
    if (!quotaResult.ok) return quotaExceededResponse(quotaResult);

    let txHash: string;
    if (signedXdr) {
      const OPERATOR = OPERATOR_PUBLIC_KEY;
      const recipient = service.stellarPublicKey ?? talos.agentWalletAddress ?? OPERATOR;
      try {
        ({ txHash } = await submitAndVerifyPayment(signedXdr, String(service.price), recipient));
      } catch (err: unknown) {
        return Response.json({ error: err instanceof Error ? err.message : "Payment submission failed" }, { status: 402 });
      }
    } else {
      txHash = legacyTxHash!;
    }

    // Replay prevention — same txHash can't be used twice
    const duplicate = await db
      .select({ id: tlsCommerceJobs.id })
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.txHash, txHash))
      .limit(1)
      .then(r => r[0] ?? null);

    if (duplicate) {
      return Response.json({ error: "Transaction already used for a job (replay)" }, { status: 409 });
    }

    // ── Instant fulfillment: run handler now and return result ────────
    if (service.fulfillmentMode === "instant") {
      let result: Record<string, unknown>;
      try {
        result = await fulfillInstant(service.serviceName, payload ?? {});
      } catch (err: unknown) {
        return Response.json(
          { error: `Fulfillment failed: ${err instanceof Error ? err.message : "unknown error"}` },
          { status: 502 },
        );
      }

      const responseBody = {
        jobId: "",          // filled in after insert
        status: "completed",
        serviceName: service.serviceName,
        result,
        txHash,
      };

      const [job] = await withTransactionRetry(
        async (tx) => {
          const [job] = await tx.insert(tlsCommerceJobs).values({
            talosId: id,
            requesterTalosId: `human:${buyerPublicKey}`,
            serviceName: service.serviceName,
            payload: payload ?? {},
            result,
            paymentSig: txHash,
            txHash,
            amount: service.price,
            status: "completed",
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }).returning();

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

          // Record terminal status to the reputation input ledger idempotently
          await ingestJobToLedger(job.id, tx);

          return [job];
        },
        { category: "JOB" }
      );

      const finalBody = { ...responseBody, jobId: job.id };
      return applyQuotaHeaders(Response.json(finalBody, { status: 201 }), quotaResult);
    }

    // ── Async: queue for agent to process ─────────────────────────────
    const responseBody = {
      jobId: "",          // filled in after insert
      status: "pending",
      serviceName: service.serviceName,
      amount: Number(service.price),
      txHash,
      message: `Job queued. The agent will process your request and you can poll for results.`,
    };

    const [job] = await withTransactionRetry(
      async (tx) => {
        const [job] = await tx.insert(tlsCommerceJobs).values({
          talosId: id,
          requesterTalosId: `human:${buyerPublicKey}`,
          serviceName: service.serviceName,
          payload: payload ?? {},
          paymentSig: txHash,
          txHash,
          amount: service.price,
          status: "pending",
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }).returning();

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
    return applyQuotaHeaders(Response.json(finalBody, { status: 201 }), quotaResult);
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === "23505") {
      // Check if the constraint is the idempotency key or the payment sig.
      const constraint = String(e?.constraint ?? e?.detail ?? "");
      if (constraint.includes("idempotencyKey")) {
        return Response.json(
          { error: "Request with this Idempotency-Key is already being processed" },
          { status: 409 },
        );
      }
      return Response.json({ error: "Transaction already used for a job (replay)" }, { status: 409 });
    }
    logger.error({ err, event: "jobs_post_error" }, "[jobs POST] Unhandled error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * GET /api/talos/:id/jobs?txHash=xxx  or  ?jobId=xxx
 * Poll job status
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  const txHash = searchParams.get("txHash");

  if (!jobId && !txHash) {
    return Response.json({ error: "Provide jobId or txHash" }, { status: 400 });
  }

  try {
    const job = jobId
      ? await db.select().from(tlsCommerceJobs)
          .where(eq(tlsCommerceJobs.id, jobId)).limit(1).then(r => r[0] ?? null)
      : await db.select().from(tlsCommerceJobs)
          .where(eq(tlsCommerceJobs.txHash, txHash!)).limit(1).then(r => r[0] ?? null);

    if (!job || job.talosId !== id) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    return Response.json({
      jobId: job.id,
      status: job.status,
      serviceName: job.serviceName,
      result: job.result,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
