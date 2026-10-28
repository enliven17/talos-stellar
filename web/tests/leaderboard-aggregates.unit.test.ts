import { describe, it, expect } from "vitest";

type Raw = {
  talos: string[];
  patrons: string[];
  activities: string[];
  revenues: { talosId: string; amount: number }[];
};

// OLD: scan raw rows on every request
function oldRanking(raw: Raw) {
  return raw.talos
    .map((id) => ({
      id,
      totalRevenue: raw.revenues.filter((r) => r.talosId === id).reduce((s, r) => s + r.amount, 0),
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue || (a.id < b.id ? 1 : -1));
}

// NEW: totals already stored, only sort
function newRanking(agg: { id: string; totalRevenue: number }[]) {
  return [...agg].sort((a, b) => b.totalRevenue - a.totalRevenue || (a.id < b.id ? 1 : -1));
}

// Same rule as the SQL cursor: revenue < c OR (revenue = c AND id < cid)
function pageAfter(rows: { id: string; totalRevenue: number }[], cursor: [number, string] | null, limit: number) {
  const f = cursor
    ? rows.filter((r) => r.totalRevenue < cursor[0] || (r.totalRevenue === cursor[0] && r.id < cursor[1]))
    : rows;
  return f.slice(0, limit);
}

// Worked example: b=150, a=100, c=100 (tie -> higher id first, so c before a), d=0
const raw: Raw = {
  talos: ["a", "b", "c", "d"],
  patrons: ["a", "b", "b", "c"],
  activities: ["a", "a", "b", "d"],
  revenues: [
    { talosId: "a", amount: 100 },
    { talosId: "b", amount: 50 },
    { talosId: "b", amount: 100 },
    { talosId: "c", amount: 100 },
  ],
};

describe("leaderboard aggregate parity", () => {
  it("new ordering equals old ordering", () => {
    const old = oldRanking(raw);
    expect(newRanking(old).map((r) => r.id)).toEqual(old.map((r) => r.id));
    expect(old.map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("cursor pagination walks every row exactly once, in order", () => {
    const ranked = newRanking(oldRanking(raw));
    const seen: string[] = [];
    let cursor: [number, string] | null = null;
    for (let i = 0; i < 10; i++) {
      const page = pageAfter(ranked, cursor, 2);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      const last = page[page.length - 1];
      cursor = [last.totalRevenue, last.id];
    }
    expect(seen).toEqual(["b", "c", "a", "d"]);
  });
});