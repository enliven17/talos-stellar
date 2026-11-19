import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, releaseJobSchema } from "@/lib/schemas";
import { withTraceContext } from "@/lib/tracing";

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

    const { data, error } = await parseBody(request, releaseJobSchema);
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

    const [released] = await db
      .update(tlsCommerceJobs)
      .set({
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(tlsCommerceJobs.id, id),
          eq(tlsCommerceJobs.leasedBy, callerTalosId),
          eq(tlsCommerceJobs.fencingToken, data.fencingToken),
        ),
      )
      .returning({ id: tlsCommerceJobs.id, status: tlsCommerceJobs.status });

    if (!released) {
      return Response.json({
        error: "Lease not held or fencing token mismatch",
      }, { status: 409 });
    }

    logger.info(
      { jobId: id, leasedBy: callerTalosId },
      "job_lease_released",
    );

    return Response.json({ released: true, jobId: id }, { status: 200 });
  } catch (err) {
    logger.error({ jobId: id, err }, "release_job_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withTraceContext(handlePost);
