import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceServices, tlsCommerceJobs, tlsRevenues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fulfillInstant } from "@/lib/fulfillment";

/**
 * POST /api/talos/:id/jobs
 *
 * Human user requests a service from an agent.
 * Accepts either:
 *   - signedXdr: signed transaction XDR (server submits + verifies payment)
 *   - txHash: already-submitted tx hash (legacy; no server-side payment check)
 *
 * Body: { buyerPublicKey, signedXdr?, txHash?, payload? }
 */
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
  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const usdc = new Asset("USDC", USDC_ISSUER);
  const ops = tx.operations as unknown as Array<{ type: string; asset?: { code: string; issuer: string }; destination?: string; amount?: string }>;
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

    const [service, talos] = await Promise.all([
      db.select().from(tlsCommerceServices).where(eq(tlsCommerceServices.talosId, id)).limit(1).then(r => r[0] ?? null),
      db.select({ id: tlsTalos.id, agentOnline: tlsTalos.agentOnline, name: tlsTalos.name, agentWalletAddress: tlsTalos.agentWalletAddress })
        .from(tlsTalos).where(eq(tlsTalos.id, id)).limit(1).then(r => r[0] ?? null),
    ]);

    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });
    if (!service) return Response.json({ error: "This agent offers no services" }, { status: 404 });

    // Submit + verify payment if signedXdr provided; otherwise use legacy txHash
    let txHash: string;
    if (signedXdr) {
      const OPERATOR = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";
      const recipient = service.stellarPublicKey ?? talos.agentWalletAddress ?? OPERATOR;
      try {
        ({ txHash } = await submitAndVerifyPayment(signedXdr, String(service.price), recipient));
      } catch (err: any) {
        return Response.json({ error: err?.message ?? "Payment submission failed" }, { status: 402 });
      }
    } else {
      txHash = legacyTxHash!;
    }

    // Replay prevention — same txHash can't be used twice
    const duplicate = await db.select({ id: tlsCommerceJobs.id })
      .from(tlsCommerceJobs).where(eq(tlsCommerceJobs.txHash, txHash)).limit(1).then(r => r[0] ?? null);
    if (duplicate) {
      return Response.json({ error: "Transaction already used for a job (replay)" }, { status: 409 });
    }

    // ── Instant fulfillment: run handler now and return result ────────
    if (service.fulfillmentMode === "instant") {
      let result: Record<string, unknown>;
      try {
        result = await fulfillInstant(service.serviceName, payload ?? {});
      } catch (err: any) {
        return Response.json(
          { error: `Fulfillment failed: ${err?.message ?? "unknown error"}` },
          { status: 502 },
        );
      }

      const [job] = await db.transaction(async (tx) => {
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
        }).returning();
        await tx.insert(tlsRevenues).values({
          talosId: id,
          amount: service.price,
          currency: service.currency ?? "USDC",
          source: "commerce",
          txHash,
        });
        return [job];
      });

      return Response.json(
        { jobId: job.id, status: "completed", serviceName: service.serviceName, result, txHash },
        { status: 201 },
      );
    }

    // ── Async: queue for agent to process ─────────────────────────────
    const [job] = await db.transaction(async (tx) => {
      const [job] = await tx.insert(tlsCommerceJobs).values({
        talosId: id,
        requesterTalosId: `human:${buyerPublicKey}`,
        serviceName: service.serviceName,
        payload: payload ?? {},
        paymentSig: txHash,
        txHash,
        amount: service.price,
        status: "pending",
      }).returning();

      await tx.insert(tlsRevenues).values({
        talosId: id,
        amount: service.price,
        currency: service.currency ?? "USDC",
        source: "commerce",
        txHash,
      });

      return [job];
    });

    return Response.json(
      {
        jobId: job.id,
        status: "pending",
        serviceName: service.serviceName,
        amount: Number(service.price),
        txHash,
        message: `Job queued. The agent will process your request and you can poll for results.`,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e?.code === "23505") {
      return Response.json({ error: "Transaction already used for a job (replay)" }, { status: 409 });
    }
    console.error("[jobs POST]", err);
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
