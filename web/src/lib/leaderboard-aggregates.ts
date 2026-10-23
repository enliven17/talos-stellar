import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsTalos, tlsLeaderboardAggregates as agg } from "@/db/schema";

export type LeaderboardCursor = [number, string];

const MIN_REFRESH_MS = 30_000;
let lastRefresh = 0;
let inFlight: Promise<void> | null = null;

/** Rebuild the stored totals. Throttled: bursts of calls cost one refresh. */
export async function refreshLeaderboardAggregates(force = false): Promise<void> {
  if (!force && Date.now() - lastRefresh < MIN_REFRESH_MS) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await db.execute(
        sql`REFRESH MATERIALIZED VIEW CONCURRENTLY "tls_leaderboard_aggregates"`,
      );
      lastRefresh = Date.now();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** One page of the leaderboard, read from the aggregate (no raw-table scans). */
export async function queryLeaderboardPage(limit: number, cursor: LeaderboardCursor | null) {
  const revenue = sql<number>`coalesce(${agg.totalRevenue}, 0)`;

  const where = cursor
    ? sql`${revenue} < ${cursor[0]}
          OR (${revenue} = ${cursor[0]} AND ${tlsTalos.id} < ${cursor[1]})`
    : undefined;

  return db
    .select({
      id: tlsTalos.id,
      name: tlsTalos.name,
      category: tlsTalos.category,
      status: tlsTalos.status,
      pulsePrice: tlsTalos.pulsePrice,
      totalSupply: tlsTalos.totalSupply,
      patronCount: agg.patronCount,
      activityCount: agg.activityCount,
      totalRevenue: revenue,
    })
    .from(tlsTalos)
    .leftJoin(agg, eq(tlsTalos.id, agg.talosId)) // left join: brand-new Talos still show up
    .where(where)
    .orderBy(sql`${revenue} desc`, desc(tlsTalos.id))
    .limit(limit + 1);
}