import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, heartbeatJobSchema } from "@/lib/schemas";

const HEARTBEAT_EXTEND_SECONDS = 300;

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

    const { data, error } = await parseBody(request, heartbeatJobSchema);
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
    const newExpiry = new Date(now.getTime() + HEARTBEAT_EXTEND_SECONDS * 1000);

    const [renewed] = await db
      .update(tlsCommerceJobs)
      .set({ leaseExpiresAt: newExpiry })
      .where(
        and(
          eq(tlsCommerceJobs.id, id),
          eq(tlsCommerceJobs.leasedBy, callerTalosId),
          eq(tlsCommerceJobs.fencingToken, data.fencingToken),
          eq(tlsCommerceJobs.status, "pending"),
        ),
      )
      .returning({ leaseExpiresAt: tlsCommerceJobs.leaseExpiresAt });

    if (!renewed) {
      return Response.json({
        error: "Lease not held or fencing token mismatch",
        detail: "The job may have been taken over by another worker or the fencing token is stale",
      }, { status: 409 });
    }

    logger.info(
      { jobId: id, leasedBy: callerTalosId, expiresAt: renewed.leaseExpiresAt },
      "job_lease_renewed",
    );

    return Response.json({ renewed: true, leaseExpiresAt: renewed.leaseExpiresAt }, { status: 200 });
  } catch (err) {
    logger.error({ jobId: id, err }, "heartbeat_job_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
