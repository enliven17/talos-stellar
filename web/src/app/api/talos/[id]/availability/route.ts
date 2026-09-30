import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { withTraceContext } from "@/lib/tracing";

export interface AvailabilityResponse {
  id: string;
  agentOnline: boolean;
  /** ISO-8601 string, or null if never seen */
  agentLastSeen: string | null;
  /** Lifecycle status: "Active" | "Paused" | "Retired" */
  status: string;
}

/**
 * GET /api/talos/:id/availability
 *
 * Returns the availability snapshot for a single agent:
 *   - agentOnline  — whether the agent is currently considered online
 *   - agentLastSeen — wall-clock timestamp of the last heartbeat (null if never)
 *   - status       — lifecycle status ("Active" | "Paused" | "Retired")
 *
 * This is a lightweight, public read endpoint. It deliberately returns only
 * non-sensitive fields. Secrets, payment proofs, and wallet keys are never
 * included.
 *
 * Errors:
 *   404 — agent not found (or soft-deleted)
 *   500 — database failure
 */
async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let row: { id: string; agentOnline: boolean; agentLastSeen: Date | null; status: string } | null =
    null;

  try {
    row = await db
      .select({
        id: tlsTalos.id,
        agentOnline: tlsTalos.agentOnline,
        agentLastSeen: tlsTalos.agentLastSeen,
        status: tlsTalos.status,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  } catch {
    return NextResponse.json(
      { error: "Service unavailable — dependency failure" },
      { status: 503 },
    );
  }

  if (!row) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body: AvailabilityResponse = {
    id: row.id,
    agentOnline: row.agentOnline,
    agentLastSeen: row.agentLastSeen ? row.agentLastSeen.toISOString() : null,
    status: row.status,
  };

  return NextResponse.json(body);
}

export const GET = withTraceContext(handleGet);
