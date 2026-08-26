import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApprovals, tlsTalos } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { internalError } from "@/lib/api-response";
import { parseAnalyticsLimit } from "@/lib/analytics-limits";

// GET /api/proposals — All proposals across all Talos, newest first
// Optional ?status=pending|approved|rejected filter, optional ?limit=1..100 (default 50)
export async function GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status");
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
      .where(status ? eq(tlsApprovals.status, status) : undefined)
      .orderBy(desc(tlsApprovals.createdAt))
      .limit(limit);

    return Response.json(rows);
  } catch {
    return internalError(request);
  }
}
