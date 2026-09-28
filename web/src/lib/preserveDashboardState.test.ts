import { describe, it, expect } from "vitest";
import {
  mergeBackgroundRefresh,
  shouldReplaceRowsOnRefresh,
  type RefreshableDashboardState,
} from "./preserveDashboardState";

type Stats = { total: number };
type Row = { id: string };

function base(): RefreshableDashboardState<Stats, Row> {
  return {
    stats: { total: 1 },
    rows: [{ id: "a" }],
    filter: "Service",
    page: 2,
    nextCursor: "c2",
    prevCursors: ["c1"],
    loading: false,
    selectedId: "a",
  };
}

describe("preserveDashboardState", () => {
  it("updates stats without resetting filter/page/selection", () => {
    const merged = mergeBackgroundRefresh(base(), { stats: { total: 9 } });
    expect(merged.stats.total).toBe(9);
    expect(merged.filter).toBe("Service");
    expect(merged.page).toBe(2);
    expect(merged.prevCursors).toEqual(["c1"]);
    expect(merged.selectedId).toBe("a");
    expect(merged.rows).toEqual([{ id: "a" }]);
  });

  it("replaces rows only when requested (page-1 soft refresh)", () => {
    const current = { ...base(), page: 1 };
    const merged = mergeBackgroundRefresh(
      current,
      { stats: { total: 3 }, rows: [{ id: "b" }], nextCursor: "n" },
      { replaceRows: true },
    );
    expect(merged.rows).toEqual([{ id: "b" }]);
    expect(merged.nextCursor).toBe("n");
    expect(merged.filter).toBe("Service");
  });

  it("does not replace rows while a manual page fetch is loading", () => {
    expect(shouldReplaceRowsOnRefresh(1, true)).toBe(false);
    expect(shouldReplaceRowsOnRefresh(1, false)).toBe(true);
    expect(shouldReplaceRowsOnRefresh(2, false)).toBe(false);
  });
});
