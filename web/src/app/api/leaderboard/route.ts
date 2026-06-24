import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { withRateLimit } from "@/lib/rate-limit";

// GET /api/leaderboard — Ranking data
export const GET = withRateLimit(
  async () => {
import { and, desc, eq, sql } from "drizzle-orm";

// GET /api/leaderboard — Ranking data with cursor-based pagination
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const cursor = searchParams.get("cursor");
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 100);

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

    if (cursor) {
      const [cursorRevenue, cursorId] = JSON.parse(
        Buffer.from(cursor, "base64").toString(),
      );
      if (typeof cursorRevenue === "number" && cursorId) {
        conditions.push(
          sql`coalesce(${revenueSum.total}, 0) < ${cursorRevenue}
              OR (coalesce(${revenueSum.total}, 0) = ${cursorRevenue}
                  AND ${tlsTalos.id} < ${cursorId})`,
        );
      }
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
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
},
{ limit: 120, windowMs: 60 * 1000 }, // 120/min
"leaderboard",
);
