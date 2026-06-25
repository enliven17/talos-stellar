import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsCommerceJobs, tlsCommerceServices, tlsRevenues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { fulfillInstant } from "@/lib/fulfillment";

/**
 * POST /api/commerce/cross-chain-webhook
 * 
 * Simulated receiver route for cross-chain payment completions (e.g., CCIP/CCTP).
 * When a payment is completed on another chain, this webhook is triggered to 
 * transition the commerce job status and trigger fulfillment.
 * 
 * Body: { jobId: string, txHash: string, chain?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { jobId, txHash, chain } = body as {
      jobId: string;
      txHash: string;
      chain?: string;
    };

    if (!jobId || !txHash) {
      return Response.json({ error: "jobId and txHash are required" }, { status: 400 });
    }

    // 1. Find the job
    const job = await db
      .select()
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.id, jobId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Commerce job not found" }, { status: 404 });
    }

    // Idempotency: If job is already pending or completed, and has the same txHash, just return success.
    if ((job.status === "pending" || job.status === "completed") && job.txHash === txHash) {
      return Response.json({
        jobId: job.id,
        status: job.status,
        txHash: job.txHash,
        message: "Payment already verified for this job.",
      }, { status: 200 });
    }

    // 2. Simulate payment verification
    // In a real scenario, we would call a bridge API or verify a proof on-chain.
    // For simulation, we consider any non-empty txHash as a valid payment.
    if (!txHash || txHash.trim() === "") {
      return Response.json({ error: "Invalid transaction hash" }, { status: 400 });
    }

    // 3. Find the associated service to determine fulfillment mode
    const service = await db
      .select()
      .from(tlsCommerceServices)
      .where(eq(tlsCommerceServices.talosId, job.talosId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!service) {
      return Response.json({ error: "Associated commerce service not found" }, { status: 404 });
    }

    // 4. Transition job status and trigger fulfillment
    if (service.fulfillmentMode === "instant") {
      let result: Record<string, unknown>;
      try {
        result = await fulfillInstant(job.serviceName, job.payload ?? {});
      } catch (err: any) {
        return Response.json(
          { error: `Fulfillment failed: ${err?.message ?? "unknown error"}` },
          { status: 502 },
        );
      }

      await db.transaction(async (tx) => {
        await tx
          .update(tlsCommerceJobs)
          .set({
            status: "completed",
            result,
            txHash,
            updatedAt: new Date(),
          })
          .where(eq(tlsCommerceJobs.id, jobId));

        await tx.insert(tlsRevenues).values({
          talosId: job.talosId,
          amount: job.amount,
          currency: service.currency ?? "USDC",
          source: "cross-chain-commerce",
          txHash,
        });
      });

      return Response.json({
        jobId: job.id,
        status: "completed",
        result,
        txHash,
        message: "Cross-chain payment verified and job fulfilled instantly.",
      }, { status: 200 });
    } else {
      // Async fulfillment: just move to pending
      await db.transaction(async (tx) => {
        await tx
          .update(tlsCommerceJobs)
          .set({
            status: "pending",
            txHash,
            updatedAt: new Date(),
          })
          .where(eq(tlsCommerceJobs.id, jobId));

        await tx.insert(tlsRevenues).values({
          talosId: job.talosId,
          amount: job.amount,
          currency: service.currency ?? "USDC",
          source: "cross-chain-commerce",
          txHash,
        });
      });

      return Response.json({
        jobId: job.id,
        status: "pending",
        txHash,
        message: "Cross-chain payment verified. Job is now pending fulfillment by the agent.",
      }, { status: 200 });
    }
  } catch (err: unknown) {
    console.error("[cross-chain-webhook POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
