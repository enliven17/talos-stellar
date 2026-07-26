import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { parseLimit } from "@/lib/parse-limit";

// GET /api/leaderboard — Ranking data with cursor-based pagination
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const parsedLimit = parseLimit(searchParams.get("limit"), 50, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    const patronCount = db
      .select({
        talosId: tlsPatrons.talosId,
        count: sql<number>`count(*)::int`.as("patronCount"),
      })
      .from(tlsPatrons)
      .groupBy(tlsPatrons.talosId)
      .as("patronCount");

    const activityCount = db
      .select({
        talosId: tlsActivities.talosId,
        count: sql<number>`count(*)::int`.as("activityCount"),
      })
      .from(tlsActivities)
      .groupBy(tlsActivities.talosId)
      .as("activityCount");

    const revenueSum = db
      .select({
        talosId: tlsRevenues.talosId,
        total: sql<number>`coalesce(sum(${tlsRevenues.amount}), 0)::float`.as("revenueTotal"),
      })
      .from(tlsRevenues)
      .groupBy(tlsRevenues.talosId)
      .as("revenueSum");

    const conditions: ReturnType<typeof sql>[] = [];

    let parsedCursor: [number, string] | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
        if (
          Array.isArray(decoded) &&
          typeof decoded[0] === "number" &&
          typeof decoded[1] === "string"
        ) {
          parsedCursor = decoded as [number, string];
        } else {
          return badRequest(request, "Invalid cursor format");
        }
      } catch {
        return badRequest(request, "Invalid cursor");
      }
    }

    if (parsedCursor) {
      const [cursorRevenue, cursorId] = parsedCursor;
      conditions.push(
        sql`coalesce(${revenueSum.total}, 0) < ${cursorRevenue}
            OR (coalesce(${revenueSum.total}, 0) = ${cursorRevenue}
                AND ${tlsTalos.id} < ${cursorId})`,
      );
    }

    const rows = await db
      .select({
        id: tlsTalos.id,
        name: tlsTalos.name,
        category: tlsTalos.category,
        status: tlsTalos.status,
        pulsePrice: tlsTalos.pulsePrice,
        totalSupply: tlsTalos.totalSupply,
        patronCount: patronCount.count,
        activityCount: activityCount.count,
        totalRevenue: sql<number>`coalesce(${revenueSum.total}, 0)`,
      })
      .from(tlsTalos)
      .leftJoin(patronCount, eq(tlsTalos.id, patronCount.talosId))
      .leftJoin(activityCount, eq(tlsTalos.id, activityCount.talosId))
      .leftJoin(revenueSum, eq(tlsTalos.id, revenueSum.talosId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`coalesce(${revenueSum.total}, 0) desc`, desc(tlsTalos.id))
      .limit(limit + 1);

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
      marketCap: Number(c.pulsePrice) * c.totalSupply,
    }));

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? Buffer.from(
            JSON.stringify([lastItem.totalRevenue, lastItem.id]),
          ).toString("base64")
        : null;

    return Response.json({ data, nextCursor });
  } catch {
    return internalError(request);
  }
}
