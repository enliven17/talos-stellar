import { NextRequest } from "next/server";
import { db } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import { tlsTalos, tlsCommerceJobs, tlsRevenues, tlsCommerceServices } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveTalosFromRequest } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { ingestJobToLedger } from "@/lib/reputation-ledger";
import { withTraceContext } from "@/lib/tracing";

// POST /api/jobs/:id/result — Submit job result (from service provider agent)
async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await resolveTalosFromRequest(request, ["commerce:write"]);
    if (!auth.ok) return auth.response;
    const callerTalosId = auth.talos.id;

    const body = await request.json();
    const { result, fencingToken } = body;

    if (!result) {
      return Response.json({ error: "result is required" }, { status: 400 });
    }

    // Backward compatibility: default to 0 when fencingToken is not provided.
    // 0 matches unclaimed jobs (initial DB default). Claimed jobs have a positive
    // token so the WHERE clause will reject stale completions.
    const effectiveFencingToken = fencingToken ?? 0;

    const job = await db
      .select()
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.talosId !== callerTalosId) {
      return Response.json({ error: "Not authorized to fulfill this job" }, { status: 403 });
    }

    const talos = await db
      .select({ id: tlsTalos.id, status: tlsTalos.status })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, callerTalosId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos || talos.status !== "Active") {
      return Response.json({ error: "This agent is not accepting new work" }, { status: 409 });
    }

    if (job.status === "completed") {
      return Response.json({ error: "Job already completed" }, { status: 409 });
    }

    // If the job is leased by someone else, reject
    if (job.leasedBy && job.leasedBy !== callerTalosId && job.leaseExpiresAt && job.leaseExpiresAt > new Date()) {
      logger.warn(
        { jobId: id, callerTalosId, leasedBy: job.leasedBy, fencingToken: effectiveFencingToken },
        "stale_worker_rejected",
      );
      return Response.json({
        error: "Job is leased by another worker",
        detail: "The fencing token is no longer valid; lease has been taken over",
      }, { status: 409 });
    }

    const updated = await withTransactionRetry(
      async (tx) => {
        // Use a WHERE with fencing token to prevent stale-worker completion
        const [updatedJob] = await tx
          .update(tlsCommerceJobs)
          .set({
            result,
            status: "completed",
          })
          .where(
            and(
              eq(tlsCommerceJobs.id, id),
              eq(tlsCommerceJobs.fencingToken, effectiveFencingToken),
              eq(tlsCommerceJobs.status, "pending"),
            ),
          )
          .returning();

        if (!updatedJob) {
          return null;
        }

        const service = await tx
          .select({ currency: tlsCommerceServices.currency })
          .from(tlsCommerceServices)
          .where(eq(tlsCommerceServices.talosId, job.talosId))
          .limit(1)
          .then((r: { currency: string }[]) => r[0] ?? null);

        await tx.insert(tlsRevenues).values({
          talosId: job.talosId,
          amount: job.amount,
          currency: service?.currency ?? "USDC",
          source: "commerce",
          txHash: job.txHash,
        });

        // Record terminal status to the reputation input ledger idempotently
        await ingestJobToLedger(job.id, tx);

        return updatedJob;
      },
      { category: "JOB" }
    );

    if (!updated) {
      return Response.json({
        error: "Fencing token mismatch",
        detail: "The job may have been re-assigned to another worker. Re-acquire a lease via POST /api/jobs/:id/claim",
      }, { status: 409 });
    }

    logger.info(
      { jobId: id, talosId: callerTalosId, fencingToken: effectiveFencingToken },
      "job_completed",
    );

    return Response.json(updated);
  } catch (err) {
    logger.error({ jobId: id, err }, "complete_job_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// GET /api/jobs/:id/result — Poll for job result (from requester agent)
async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await resolveTalosFromRequest(request, ["commerce:read"]);
    if (!auth.ok) return auth.response;
    const callerTalosId = auth.talos.id;

    const job = await db
      .select()
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.talosId !== callerTalosId && job.requesterTalosId !== callerTalosId) {
      return Response.json({ error: "Not authorized to view this job" }, { status: 403 });
    }

    return Response.json({
      id: job.id,
      status: job.status,
      result: job.result,
      talosId: job.talosId,
      serviceName: job.serviceName,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withTraceContext(handlePost);
export const GET = withTraceContext(handleGet);
