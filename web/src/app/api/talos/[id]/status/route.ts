import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { withTraceContext } from "@/lib/tracing";

const VALID_LIFECYCLE_STATUSES = new Set(["Active", "Paused", "Retired"]);

function normalizeLifecycleStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const titleCased = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
  return VALID_LIFECYCLE_STATUSES.has(titleCased) ? titleCased : null;
}

// PATCH /api/talos/:id/status — Agent status update (online/offline)
async function handlePatch(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["settings:write"]);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { agentOnline, lifecycleStatus, governanceApproved } = body as {
      agentOnline?: boolean;
      lifecycleStatus?: string;
      governanceApproved?: boolean;
    };

    if (typeof agentOnline !== "undefined" && typeof agentOnline !== "boolean") {
      return Response.json(
        { error: "agentOnline must be a boolean" },
        { status: 400 }
      );
    }

    const normalizedLifecycleStatus = normalizeLifecycleStatus(lifecycleStatus);
    if (typeof lifecycleStatus !== "undefined" && !normalizedLifecycleStatus) {
      return Response.json(
        { error: "lifecycleStatus must be one of: Active, Paused, Retired" },
        { status: 400 }
      );
    }

    const current = await db
      .select({ id: tlsTalos.id, status: tlsTalos.status, agentOnline: tlsTalos.agentOnline })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!current) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const nextAgentOnline = typeof agentOnline === "boolean" ? agentOnline : current.agentOnline;
    const nextStatus = normalizedLifecycleStatus ?? current.status;

    if (nextStatus === "Retired" && governanceApproved !== true) {
      return Response.json(
        { error: "Retirement requires explicit governance confirmation" },
        { status: 403 }
      );
    }

    const updates: Record<string, unknown> = {
      agentOnline: nextAgentOnline,
      agentLastSeen: new Date(),
    };

    if (normalizedLifecycleStatus) {
      updates.status = nextStatus;
    }

    const [updated] = await db
      .update(tlsTalos)
      .set(updates)
      .where(eq(tlsTalos.id, id))
      .returning();

    if (normalizedLifecycleStatus && (nextStatus === "Paused" || nextStatus === "Retired")) {
      await db
        .update(tlsCommerceJobs)
        .set({
          status: "cancelled",
          leasedBy: null,
          leasedAt: null,
          leaseExpiresAt: null,
        })
        .where(and(eq(tlsCommerceJobs.talosId, id), eq(tlsCommerceJobs.status, "pending")))
        .returning();
    }

    return Response.json({
      id: updated.id,
      status: updated.status,
      agentOnline: updated.agentOnline,
      agentLastSeen: updated.agentLastSeen,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const PATCH = withTraceContext(handlePatch);
