import { describe, it, expect } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { queryLeaderboardPage, refreshLeaderboardAggregates } from "@/lib/leaderboard-aggregates";

async function oldQuery(limit: number) {
  const patronCount = db.select({ talosId: tlsPatrons.talosId, count: sql<number>`count(*)::int`.as("patronCount") })
    .from(tlsPatrons).groupBy(tlsPatrons.talosId).as("patronCount");
  const activityCount = db.select({ talosId: tlsActivities.talosId, count: sql<number>`count(*)::int`.as("activityCount") })
    .from(tlsActivities).groupBy(tlsActivities.talosId).as("activityCount");
  const revenueSum = db.select({ talosId: tlsRevenues.talosId, total: sql<number>`coalesce(sum(${tlsRevenues.amount}), 0)::float`.as("revenueTotal") })
    .from(tlsRevenues).groupBy(tlsRevenues.talosId).as("revenueSum");

  return db
    .select({
      id: tlsTalos.id,
      patronCount: patronCount.count,
      activityCount: activityCount.count,
      totalRevenue: sql<number>`coalesce(${revenueSum.total}, 0)`,
    })
    .from(tlsTalos)
    .leftJoin(patronCount, eq(tlsTalos.id, patronCount.talosId))
    .leftJoin(activityCount, eq(tlsTalos.id, activityCount.talosId))
    .leftJoin(revenueSum, eq(tlsTalos.id, revenueSum.talosId))
    .orderBy(sql`coalesce(${revenueSum.total}, 0) desc`, desc(tlsTalos.id))
    .limit(limit);
}

describe.skipIf(!process.env.DATABASE_URL)("leaderboard parity on real data", () => {
  it("new query returns the same rows, order and totals as the old one", async () => {
    await refreshLeaderboardAggregates(true);
    const oldRows = await oldQuery(200);
    const newRows = (await queryLeaderboardPage(199, null)).slice(0, 200);

    const pick = (r: { id: string; patronCount: number | null; activityCount: number | null; totalRevenue: number | null }) => ({
      id: r.id,
      patronCount: r.patronCount ?? 0,
      activityCount: r.activityCount ?? 0,
      totalRevenue: Number(r.totalRevenue ?? 0),
    });

    expect(oldRows.length).toBeGreaterThan(0);
    expect(newRows.map(pick)).toEqual(oldRows.map(pick));
  });
});