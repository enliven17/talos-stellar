import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApprovals, tlsTalos } from "@/db/schema";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { badRequest, internalError } from "@/lib/api-response";
import { parseAnalyticsLimit } from "@/lib/analytics-limits";
import { PROPOSALS_DEFAULT_LIMIT, PROPOSALS_MAX_LIMIT } from "@/lib/limits";
import { PROPOSAL_TYPES } from "@/lib/proposals-filters";
import { decodeProposalCursor, encodeProposalCursor } from "./cursor";

// GET /api/proposals — Proposals across all Talos, newest first, cursor-paginated
// Optional filters: ?status=pending|approved|rejected, ?talosId=<id>, ?type=<proposal type>
// Optional paging:  ?limit=1..100 (default 50), ?cursor=<opaque nextCursor from previous page>
// Response: { proposals, nextCursor, talos } — `talos` (id/name pairs for the
// filter dropdown) is only included on the first page (no cursor).
async function _GET(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const status = searchParams.get("status");
  const talosId = searchParams.get("talosId");
  const type = searchParams.get("type");
  const rawCursor = searchParams.get("cursor");

  const parsedLimit = parseAnalyticsLimit(
    searchParams.get("limit"),
    PROPOSALS_DEFAULT_LIMIT,
    PROPOSALS_MAX_LIMIT,
  );
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

  if (type !== null && !(PROPOSAL_TYPES as readonly string[]).includes(type)) {
    return badRequest(request, `type must be one of: ${PROPOSAL_TYPES.join(", ")}`);
  }

  let cursor = null;
  if (rawCursor !== null) {
    cursor = decodeProposalCursor(rawCursor);
    if (!cursor) return badRequest(request, "Invalid cursor");
  }

  try {
    const conditions = [];
    if (status) conditions.push(eq(tlsApprovals.status, status));
    if (talosId) conditions.push(eq(tlsApprovals.talosId, talosId));
    if (type) conditions.push(eq(tlsApprovals.type, type));
    if (cursor) {
      conditions.push(
        or(
          lt(tlsApprovals.createdAt, cursor.createdAt),
          and(eq(tlsApprovals.createdAt, cursor.createdAt), lt(tlsApprovals.id, cursor.id)),
        ),
      );
    }

    // Fetch one extra row to learn whether another page exists.
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
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tlsApprovals.createdAt), desc(tlsApprovals.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const proposals = hasMore ? rows.slice(0, limit) : rows;
    const last = proposals[proposals.length - 1];
    const nextCursor = hasMore && last ? encodeProposalCursor(last) : null;

    if (cursor) return Response.json({ proposals, nextCursor });

    // First page only: the Talos that have proposals, for the filter dropdown.
    const talos = await db
      .select({ id: tlsTalos.id, name: tlsTalos.name })
      .from(tlsTalos)
      .innerJoin(tlsApprovals, eq(tlsApprovals.talosId, tlsTalos.id))
      .groupBy(tlsTalos.id, tlsTalos.name)
      .orderBy(asc(tlsTalos.name));
      .where(parsedStatus.status ? eq(tlsApprovals.status, parsedStatus.status) : undefined)
      .orderBy(desc(tlsApprovals.createdAt))
      .limit(limit);

    return Response.json({ proposals, nextCursor, talos });
  } catch {
    return internalError(request);
  }
}

export const GET = withRequestId(_GET);
