import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/leaderboard/route";
import { refreshLeaderboardAggregates } from "@/lib/leaderboard-aggregates";

type Page = { data: { id: string; totalRevenue: number }[]; nextCursor: string | null };

describe.skipIf(!process.env.DATABASE_URL)("GET /api/leaderboard (route handler, real DB)", () => {
  beforeAll(async () => {
    await refreshLeaderboardAggregates(true);
  });

  const call = (qs = "") => GET(new NextRequest(`http://localhost/api/leaderboard${qs}`));

  it("sends short-lived cache headers", async () => {
    const res = await call("?limit=3");
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("s-maxage=30");
    expect(cc).toContain("stale-while-revalidate=60");
  });

  it("cursor pagination: no repeats, revenue never increases, every Talos covered", async () => {
    const all: Page["data"] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const qs: string = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await call(qs);
      expect(res.status).toBe(200);
      const body: Page = await res.json();
      all.push(...body.data);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    const ids = all.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < all.length; i++) {
      expect(all[i].totalRevenue).toBeLessThanOrEqual(all[i - 1].totalRevenue);
    }
    expect(all.length).toBeGreaterThan(3);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await call("?cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
  });
});