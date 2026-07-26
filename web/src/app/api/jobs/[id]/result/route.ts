import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs, tlsRevenues, tlsCommerceServices } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";

async function resolveCallerTalos(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const talos = await db
    .select({ id: tlsTalos.id })
    .from(tlsTalos)
    .where(eq(tlsTalos.apiKey, token))
    .limit(1)
    .then((r) => r[0] ?? null);
  return talos?.id ?? null;
}

// POST /api/jobs/:id/result — Submit job result (from service provider agent)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

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

    const updated = await db.transaction(async (tx) => {
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
        .then((r) => r[0] ?? null);

      await tx.insert(tlsRevenues).values({
        talosId: job.talosId,
        amount: job.amount,
        currency: service?.currency ?? "USDC",
        source: "commerce",
        txHash: job.txHash,
      });

      return updatedJob;
    });

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
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

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
