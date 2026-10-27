import { withRequestId } from "@/lib/with-request-id";
import { NextRequest, after } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { calculateMarketCap } from "@/lib/market-cap";
import { badRequest, internalError } from "@/lib/api-response";
import { parseLimit, LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT, MAX_CURSOR_LENGTH } from "@/lib/limits";
import {
  queryLeaderboardPage,
  refreshLeaderboardAggregates,
  type LeaderboardCursor,
} from "@/lib/leaderboard-aggregates";

// GET /api/leaderboard — Ranking data with cursor-based pagination
async function _GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const parsedLimit = parseLimit(searchParams.get("limit"), LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    let parsedCursor: LeaderboardCursor | null = null;
    if (cursor) {
      if (cursor.length > MAX_CURSOR_LENGTH) {
        return badRequest(request, "Invalid cursor");
      }
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
        if (
          Array.isArray(decoded) &&
          decoded.length === 2 &&
          (typeof decoded[0] === "string" || typeof decoded[0] === "number") &&
          typeof decoded[1] === "string"
        ) {
          parsedCursor = decoded as LeaderboardCursor;
        } else {
          return badRequest(request, "Invalid cursor format");
        }
      } catch {
        return badRequest(request, "Invalid cursor");
      }
    }

    const rows = await queryLeaderboardPage(limit, parsedCursor);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = page.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      status: c.status,
      pulsePrice: c.pulsePrice,
      totalSupply: c.totalSupply,
      patronCount: c.patronCount ?? 0,
      activityCount: c.activityCount ?? 0,
      totalRevenue: c.totalRevenue ?? 0,
      marketCap: calculateMarketCap(c.pulsePrice, c.totalSupply),
    }));

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? Buffer.from(JSON.stringify([lastItem.totalRevenue, lastItem.id])).toString("base64")
        : null;

    // Keep the aggregate fresh after the response is sent (throttled to once / 30s)
    try {
      after(() => refreshLeaderboardAggregates().catch(() => {}));
    } catch {
      /* not in a request scope (e.g. unit tests) */
    }

    return Response.json(
      { data, nextCursor },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch {
    return internalError(request);
  }
}

export const GET = withRequestId(_GET);