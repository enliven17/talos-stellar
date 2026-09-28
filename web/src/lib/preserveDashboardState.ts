/**
 * Preserve user-controlled dashboard UI state across background data refreshes.
 *
 * Background polls must update stats / rows without resetting filters, page
 * cursor stacks, or in-flight loading flags — otherwise operators lose place
 * every few seconds while the live feed ticks.
 */

export type RefreshableDashboardState<TStats, TRow> = {
  stats: TStats;
  rows: TRow[];
  filter: string;
  page: number;
  nextCursor: string | null;
  prevCursors: string[];
  loading: boolean;
  /** Optional row id the user has selected / expanded. */
  selectedId?: string | null;
};

export type BackgroundRefreshPayload<TStats, TRow> = {
  stats: TStats;
  /** When omitted or when not on page 1, existing rows are kept. */
  rows?: TRow[];
  nextCursor?: string | null;
};

/**
 * Merge a background refresh into existing UI state.
 * Preserves: filter, page, prevCursors, loading, selectedId.
 * Updates: stats always; rows/nextCursor only when `replaceRows` is true.
 */
export function mergeBackgroundRefresh<TStats, TRow>(
  current: RefreshableDashboardState<TStats, TRow>,
  payload: BackgroundRefreshPayload<TStats, TRow>,
  opts: { replaceRows: boolean } = { replaceRows: false },
): RefreshableDashboardState<TStats, TRow> {
  return {
    ...current,
    stats: payload.stats,
    rows: opts.replaceRows && payload.rows ? payload.rows : current.rows,
    nextCursor:
      opts.replaceRows && payload.nextCursor !== undefined
        ? payload.nextCursor
        : current.nextCursor,
    // Explicitly preserved:
    filter: current.filter,
    page: current.page,
    prevCursors: current.prevCursors,
    loading: current.loading,
    selectedId: current.selectedId,
  };
}

/** True when a refresh should replace the visible row set (first page only). */
export function shouldReplaceRowsOnRefresh(page: number, loading: boolean): boolean {
  return page === 1 && !loading;
}
