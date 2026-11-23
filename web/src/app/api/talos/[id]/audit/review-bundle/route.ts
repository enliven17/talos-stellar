/**
 * GET /api/talos/:id/audit/review-bundle — bounded audit references and the
 * current hash-chain checkpoint for the authenticated agent.
 */

import { NextRequest } from "next/server";
import { withRequestId } from "@/lib/with-request-id";
import { verifyAgentApiKey } from "@/lib/auth";
import { getAgentAuditReviewBundle } from "@/lib/audit-log";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const searchParams = new URL(request.url).searchParams;
    const limitParam = searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) {
        return Response.json({ error: "limit must be an integer between 1 and 200" }, { status: 400 });
      }
      limit = Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return Response.json({ error: "limit must be an integer between 1 and 200" }, { status: 400 });
      }
    }

    const cursorParam = searchParams.get("cursor");
    let cursor: string | undefined;
    if (cursorParam !== null) {
      const parsedCursor = new Date(cursorParam);
      if (Number.isNaN(parsedCursor.getTime())) {
        return Response.json({ error: "cursor must be a valid ISO-8601 timestamp" }, { status: 400 });
      }
      cursor = parsedCursor.toISOString();
    }

    const bundle = await getAgentAuditReviewBundle(id, limit, cursor);
    return Response.json({ talosId: id, ...bundle });
  } catch (err) {
    logger.error({ err, talosId: id }, "audit_review_bundle_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);
