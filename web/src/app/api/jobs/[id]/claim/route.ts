import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, and, lt, or, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, claimJobSchema } from "@/lib/schemas";

const DEFAULT_LEASE_TTL_SECONDS = 300;

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

    const { data, error } = await parseBody(request, claimJobSchema);
    if (error) return error;

    const ttlSeconds = data.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Atomic lease acquisition: only succeeds if the job is pending and
    // either unleased or the previous lease has expired.
    const [claimed] = await db
      .update(tlsCommerceJobs)
      .set({
        leasedBy: callerTalosId,
        leasedAt: now,
        leaseExpiresAt: expiresAt,
        fencingToken: sql`${tlsCommerceJobs.fencingToken} + 1`,
      })
      .where(
        and(
          eq(tlsCommerceJobs.id, id),
          eq(tlsCommerceJobs.status, "pending"),
          or(
            eq(tlsCommerceJobs.leasedBy, callerTalosId),
            eq(tlsCommerceJobs.leasedBy, null as unknown as string),
            lt(tlsCommerceJobs.leaseExpiresAt, now),
          ),
        ),
      )
      .returning({
        id: tlsCommerceJobs.id,
        leasedBy: tlsCommerceJobs.leasedBy,
        leasedAt: tlsCommerceJobs.leasedAt,
        leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt,
        fencingToken: tlsCommerceJobs.fencingToken,
        status: tlsCommerceJobs.status,
      });

    if (!claimed) {
      // Check if job exists at all
      const job = await db
        .select({ id: tlsCommerceJobs.id, status: tlsCommerceJobs.status })
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

      return Response.json({
        error: "Job is already leased by another worker",
        detail: "The job has a valid, unexpired lease held by another agent",
      }, { status: 409 });
    }

    logger.info(
      { jobId: id, leasedBy: callerTalosId, fencingToken: claimed.fencingToken, ttlSeconds },
      "job_lease_acquired",
    );

    return Response.json(claimed, { status: 200 });
  } catch (err) {
    logger.error({ jobId: id, err }, "claim_job_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
