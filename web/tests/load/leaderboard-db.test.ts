import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsRevenues } from "@/db/schema";
import { queryLeaderboardPage, refreshLeaderboardAggregates } from "@/lib/leaderboard-aggregates";
import { percentile } from "./types";

/**
 * Load test: the leaderboard query, old (aggregate raw tables per request)
 * versus new (read the maintained aggregate), under concurrent load.
 *
 * Opt-in because it inserts and then deletes about 400k temporary revenue rows:
 *   $env:DATABASE_URL = "postgresql://..."   # a throwaway dev database
 *   $env:LOAD_DB = "1"
 *   pnpm vitest run tests/load/leaderboard-db.test.ts
 */
const ENABLED = Boolean(process.env.DATABASE_URL) && process.env.LOAD_DB === "1";
const ROWS_PER_TALOS = 50_000;
const CONCURRENCY = 4;
const BATCHES = 8;

// OLD: the per-request aggregation the route used before this change
function oldQuery(limit: number) {
  const patronCount = db
    .select({ talosId: tlsPatrons.talosId, count: sql<number>`count(*)::int`.as("patronCount") })
    .from(tlsPatrons).groupBy(tlsPatrons.talosId).as("patronCount");
  const activityCount = db
    .select({ talosId: tlsActivities.talosId, count: sql<number>`count(*)::int`.as("activityCount") })
    .from(tlsActivities).groupBy(tlsActivities.talosId).as("activityCount");
  const revenueSum = db
    .select({
      talosId: tlsRevenues.talosId,
      total: sql<number>`coalesce(sum(${tlsRevenues.amount}), 0)::float`.as("revenueTotal"),
    })
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
    .limit(limit + 1);
}

async function measure(run: () => Promise<unknown>): Promise<number[]> {
  const latencies: number[] = [];
  for (let b = 0; b < BATCHES; b++) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const start = performance.now();
        await run();
        return performance.now() - start;
      }),
    );
    latencies.push(...batch);
  }
  return latencies;
}

describe.skipIf(!ENABLED)("leaderboard query under load: old vs new", () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO tls_revenues (id, "talosId", amount, source)
      SELECT gen_random_uuid()::text, t.id, (random() * 100)::numeric(18,6), 'loadtest'
      FROM tls_talos t CROSS JOIN generate_series(1, ${sql.raw(String(ROWS_PER_TALOS))})`);
    await db.execute(sql`ANALYZE tls_revenues`);
    await refreshLeaderboardAggregates(true);
  }, 300_000);

  afterAll(async () => {
    await db.execute(sql`DELETE FROM tls_revenues WHERE source = 'loadtest'`);
    await refreshLeaderboardAggregates(true);
  }, 300_000);

  it("the new query is much faster than the old one", async () => {
    const oldMs = await measure(() => oldQuery(20));
    const newMs = await measure(() => queryLeaderboardPage(20, null));

    const stats = {
      old: { p50: Math.round(percentile(oldMs, 0.5)), p95: Math.round(percentile(oldMs, 0.95)) },
      new: { p50: Math.round(percentile(newMs, 0.5)), p95: Math.round(percentile(newMs, 0.95)) },
    };
    console.log("leaderboard load result (ms):", stats);

    // Deliberately loose: the real gap is orders of magnitude.
    expect(percentile(newMs, 0.95)).toBeLessThan(percentile(oldMs, 0.5) / 2);
  }, 300_000);
});