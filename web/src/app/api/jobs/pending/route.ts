import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
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

// GET /api/jobs/pending — Get pending jobs for the authenticated TALOS (as service provider)
export async function GET(request: NextRequest) {
  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 200);

    const now = new Date();

    // Return pending jobs that are:
    //   - not leased (null), OR
    //   - leased by this caller (so it can continue working), OR
    //   - lease has expired (available for re-claim)
    const conditions = [
      eq(tlsCommerceJobs.talosId, callerTalosId),
      eq(tlsCommerceJobs.status, "pending"),
      eq(tlsTalos.status, "Active"),
      or(
        eq(tlsCommerceJobs.leasedBy, null as unknown as string),
        eq(tlsCommerceJobs.leasedBy, callerTalosId),
        lt(tlsCommerceJobs.leaseExpiresAt, now),
      ),
    ];
    if (cursor) conditions.push(sql`${tlsCommerceJobs.createdAt} > ${new Date(cursor)}`);

    const rows = await db
      .select({
        id: tlsCommerceJobs.id,
        talosId: tlsCommerceJobs.talosId,
        requesterTalosId: tlsCommerceJobs.requesterTalosId,
        serviceName: tlsCommerceJobs.serviceName,
        payload: tlsCommerceJobs.payload,
        result: tlsCommerceJobs.result,
        status: tlsCommerceJobs.status,
        paymentSig: tlsCommerceJobs.paymentSig,
        txHash: tlsCommerceJobs.txHash,
        amount: tlsCommerceJobs.amount,
        bidPrice: tlsCommerceJobs.bidPrice,
        idempotencyKey: tlsCommerceJobs.idempotencyKey,
        idempotencyResponse: tlsCommerceJobs.idempotencyResponse,
        leasedBy: tlsCommerceJobs.leasedBy,
        leasedAt: tlsCommerceJobs.leasedAt,
        leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt,
        fencingToken: tlsCommerceJobs.fencingToken,
        createdAt: tlsCommerceJobs.createdAt,
        updatedAt: tlsCommerceJobs.updatedAt,
      })
      .from(tlsCommerceJobs)
      .innerJoin(tlsTalos, eq(tlsCommerceJobs.talosId, tlsTalos.id))
      .where(and(...conditions))
      .orderBy(asc(tlsCommerceJobs.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const jobs = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? jobs[jobs.length - 1]?.createdAt.toISOString() ?? null : null;

    logger.info(
      { talosId: callerTalosId, count: jobs.length, hasMore },
      "pending_jobs_fetched",
    );

    return Response.json({ jobs, nextCursor });
  } catch (err) {
    logger.error({ err }, "pending_jobs_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
