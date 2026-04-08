import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices, tlsCommerceJobs, tlsRevenues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { verifyX402Payment, settleX402Payment } from "@/lib/stellar-x402";
import { fulfillInstant } from "@/lib/fulfillment";
import { registerServiceSchema, parseBody } from "@/lib/schemas";

const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

// GET /api/talos/:id/service — Returns 402 with payment details (x402 storefront)
export async function GET(
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
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // 1. Authenticate requester TALOS via API key (check early)
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 }
      );
    }
    const apiKeyToken = authHeader.slice(7);
    const requester = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.apiKey, apiKeyToken))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!requester) {
      return Response.json({ error: "Invalid API key" }, { status: 403 });
    }

    // 1b. Read body once (request body can only be consumed once)
    const requestBody = await request.json().catch(() => ({})) as Record<string, unknown>;

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

    // 3. Replay prevention — check payment token against existing jobs
    const existingJob = await db
      .select({ id: tlsCommerceJobs.id })
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.paymentSig, paymentToken))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existingJob) {
      return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
    }

    // 4. Verify x402 payment via facilitator (checks signature, amount, destination)
    const expectedAmount = String(service.price);
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

    // 6. Create commerce job + fulfill
    const payload = (requestBody.payload ?? requestBody) as Record<string, unknown>;

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

      const [job] = await db
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
          status: "completed",
        })
        .returning();

      // Record revenue for the service provider
      await db.insert(tlsRevenues).values({
        talosId: id,
        amount: service.price,
        currency: service.currency ?? "USDC",
        source: "commerce",
        txHash,
      });

      return Response.json(
        { id: job.id, jobId: job.id, status: "completed", result, txHash },
        { status: 201 }
      );
    }

    // Async mode: create pending job for agent to fulfill via polling
    // Revenue is recorded when the job is fulfilled, not on creation
    const [job] = await db
      .insert(tlsCommerceJobs)
      .values({
        talosId: id,
        requesterTalosId: requester.id,
        serviceName: service.serviceName,
        payload: payload ?? undefined,
        paymentSig: paymentToken,
        txHash,
        amount: service.price,
        status: "pending",
      })
      .returning();

    return Response.json(
      { id: job.id, jobId: job.id, status: "pending", txHash },
      { status: 201 }
    );
  } catch (err: unknown) {
    // Catch unique constraint violation on paymentSig (replay race condition)
    const e = err as Record<string, unknown>;
    if (e?.code === "23505" && String(e?.constraint ?? "").includes("paymentSig")) {
      return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
    }
    console.error("Service POST error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT /api/talos/:id/service — Register or update commerce service (upsert)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
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
