import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, extendLeaseSchema } from "@/lib/schemas";
import { withTraceContext } from "@/lib/tracing";

// A single call may only push the lease out this far (mirrors the claim
// route's ttlSeconds ceiling); repeated calls are still capped by
// MAX_LEASE_SECONDS below, so a lease can never drift into the far future.
const MAX_LEASE_SECONDS = 86400;

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

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, extendLeaseSchema);
    if (error) return error;

    const talos = await db
      .select({ id: tlsTalos.id, status: tlsTalos.status })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, callerTalosId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos || talos.status !== "Active") {
      return Response.json({ error: "This agent is not accepting new work" }, { status: 409 });
    }

    const now = new Date();
    const job = await db
      .select({
        id: tlsCommerceJobs.id,
        status: tlsCommerceJobs.status,
        leasedBy: tlsCommerceJobs.leasedBy,
        leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt,
        fencingToken: tlsCommerceJobs.fencingToken,
      })
      .from(tlsCommerceJobs)
      .where(eq(tlsCommerceJobs.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.status !== "pending") {
      return Response.json({ error: "Job is not pending" }, { status: 409 });
    }
    if (!job.leaseExpiresAt) {
      return Response.json({
        error: "Job has no active lease",
        detail: "Claim the job before extending its lease",
      }, { status: 409 });
    }
    // Unlike heartbeat, an expired lease is never resurrected here: the
    // holder has to re-claim the job, which bumps the fencing token.
    if (job.leaseExpiresAt.getTime() <= now.getTime()) {
      return Response.json({
        error: "Lease expired",
        detail: "The lease is no longer valid; claim the job again to restart work",
      }, { status: 409 });
    }
    if (job.leasedBy !== callerTalosId || job.fencingToken !== data.fencingToken) {
      return Response.json({
        error: "Lease not held or fencing token mismatch",
        detail: "The job may have been taken over by another worker or the fencing token is stale",
      }, { status: 409 });
    }

    // Extend additively from the current expiry so a longer lease can never
    // shrink, and refuse anything that would cross the absolute horizon.
    const newExpiry = new Date(job.leaseExpiresAt.getTime() + data.extendSeconds * 1000);
    const horizon = new Date(now.getTime() + MAX_LEASE_SECONDS * 1000);
    if (newExpiry.getTime() > horizon.getTime()) {
      return Response.json({
        error: "Lease extension exceeds maximum",
        detail: `A lease cannot be extended more than ${MAX_LEASE_SECONDS} seconds from now`,
      }, { status: 422 });
    }

    // Re-assert every lease condition atomically so a takeover or an expiry
    // that lands between the read and the write cannot be overwritten.
    const [extended] = await db
      .update(tlsCommerceJobs)
      .set({ leaseExpiresAt: newExpiry })
      .where(
        and(
          eq(tlsCommerceJobs.id, id),
          eq(tlsCommerceJobs.leasedBy, callerTalosId),
          eq(tlsCommerceJobs.fencingToken, data.fencingToken),
          eq(tlsCommerceJobs.status, "pending"),
          gt(tlsCommerceJobs.leaseExpiresAt, now),
        ),
      )
      .returning({ leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt });

    if (!extended) {
      return Response.json({
        error: "Lease not held or fencing token mismatch",
        detail: "The job may have been taken over by another worker or the fencing token is stale",
      }, { status: 409 });
    }

    logger.info(
      {
        jobId: id,
        leasedBy: callerTalosId,
        extendSeconds: data.extendSeconds,
        expiresAt: extended.leaseExpiresAt,
      },
      "job_lease_extended",
    );

    return Response.json(
      { extended: true, leaseExpiresAt: extended.leaseExpiresAt },
      { status: 200 },
    );
  } catch (err) {
    logger.error({ jobId: id, err }, "extend_lease_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withTraceContext(handlePost);
