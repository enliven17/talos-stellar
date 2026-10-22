import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { listContractEvents } from "@/lib/contract-events";

/**
 * GET /api/contract-events
 *
 * Read-only contract events endpoint with cursor pagination.
 * Query params:
 *   - contractId (optional): filter by emitting contract address
 *   - topic (optional): filter by event topic (e.g. tls_crt, vote, ep_cmt)
 *   - cursor (optional): pagination cursor (${ledger}_${id} or event id)
 *   - limit (optional): page limit between 1 and 100 (default: 50)
 */
async function _GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const contractId = searchParams.get("contractId") ?? undefined;
    const topic = searchParams.get("topic") ?? undefined;
    const cursor = searchParams.get("cursor") ?? undefined;
    const limitParam = searchParams.get("limit");

    let limit: number | undefined;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (isNaN(parsed) || parsed < 1) {
        return Response.json(
          { error: "limit must be a positive integer" },
          { status: 400 },
        );
      }
      limit = Math.min(parsed, 100);
    }

    const { events, nextCursor } = await listContractEvents({
      contractId,
      topic,
      cursor,
      limit,
    });

    return Response.json({
      events,
      nextCursor,
    });
  } catch (err) {
    console.error("[contract-events GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);
