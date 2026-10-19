import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApprovals, tlsTalos } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { internalError } from "@/lib/api-response";
import { parseAnalyticsLimit } from "@/lib/analytics-limits";

const ALLOWED_STATUSES = ["pending", "approved", "rejected"] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function parseStatus(rawStatus: string | null): 
  | { ok: true; status: AllowedStatus | undefined } 
  | { ok: false; error: string } {
  if (!rawStatus) return { ok: true, status: undefined };
  
  const normalized = rawStatus.toLowerCase();
  if (ALLOWED_STATUSES.includes(normalized as AllowedStatus)) {
    return { ok: true, status: normalized as AllowedStatus };
  }
  
  return { 
    ok: false, 
    error: `Invalid status "${rawStatus}". Allowed: ${ALLOWED_STATUSES.join(", ")}` 
  };
}

// GET /api/proposals — All proposals across all Talos, newest first
// Optional ?status=pending|approved|rejected filter, optional ?limit=1..100 (default 50)
async function _GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const rawStatus = searchParams.get("status");
  
  const parsedStatus = parseStatus(rawStatus);
  if (!parsedStatus.ok) {
    return Response.json(
      { error: parsedStatus.error }, 
      { status: 400 }
    );
  }
  
  const parsedLimit = parseAnalyticsLimit(searchParams.get("limit"), 50, 100);
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = parsedLimit.limit;

  try {
    const rows = await db
      .select({
        id: tlsApprovals.id,
        talosId: tlsApprovals.talosId,
        talosName: tlsTalos.name,
        type: tlsApprovals.type,
        title: tlsApprovals.title,
        description: tlsApprovals.description,
        amount: tlsApprovals.amount,
        status: tlsApprovals.status,
        decidedBy: tlsApprovals.decidedBy,
        decidedAt: tlsApprovals.decidedAt,
        txHash: tlsApprovals.txHash,
        createdAt: tlsApprovals.createdAt,
      })
      .from(tlsApprovals)
      .innerJoin(tlsTalos, eq(tlsApprovals.talosId, tlsTalos.id))
      .where(parsedStatus.status ? eq(tlsApprovals.status, parsedStatus.status) : undefined)
      .orderBy(desc(tlsApprovals.createdAt))
      .limit(limit);

    return Response.json(rows);
  } catch {
    return internalError(request);
  }
}

export const GET = withRequestId(_GET);
