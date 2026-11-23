/**
 * Pure helpers that keep "no observation recorded" distinct from a verified
 * zero revenue observation.
 *
 * A missing observation means the data source returned nothing for the
 * period. That is not evidence of zero revenue, so callers must render an
 * unavailable placeholder instead of `$0.00`. A present observation whose
 * amount is `0` is a verified zero and renders as `$0.00`.
 */

export interface RevenueObservation {
  amount: number | string;
  source?: string;
}

export interface RevenueObservationSummary {
  hasObservations: boolean;
  /** Sum of observed amounts, or `null` when nothing was observed. */
  total: number | null;
  /** Per-source totals, or `null` when nothing was observed. */
  bySource: Record<string, number> | null;
}

export interface MonthlyRevenueSummary {
  hasObservations: boolean;
  /** Latest observed month amount, or `null` when nothing was observed. */
  thisMonth: number | null;
  /** Mean observed month amount, or `null` when nothing was observed. */
  averageMonthly: number | null;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Summarize a list of revenue records. Returns `hasObservations: false` and
 * `null` aggregates for an empty or absent list so callers never invent a
 * zero total.
 */
export function summarizeRevenueObservations(
  observations: RevenueObservation[] | null | undefined,
): RevenueObservationSummary {
  if (!Array.isArray(observations) || observations.length === 0) {
    return { hasObservations: false, total: null, bySource: null };
  }

  let total = 0;
  const bySource: Record<string, number> = {};
  for (const observation of observations) {
    const amount = toFiniteNumber(observation.amount);
    if (amount === null) continue;
    total += amount;
    if (observation.source) {
      bySource[observation.source] = (bySource[observation.source] ?? 0) + amount;
    }
  }

  return { hasObservations: true, total, bySource };
}

/**
 * Summarize monthly revenue history for the agent detail panels. Returns
 * `null` aggregates when the history is empty or absent.
 */
export function summarizeMonthlyRevenue(
  history: { month: string; amount: number }[] | null | undefined,
): MonthlyRevenueSummary {
  if (!Array.isArray(history) || history.length === 0) {
    return { hasObservations: false, thisMonth: null, averageMonthly: null };
  }

  const amounts = history
    .map((entry) => toFiniteNumber(entry?.amount))
    .filter((amount): amount is number => amount !== null);

  if (amounts.length === 0) {
    return { hasObservations: true, thisMonth: null, averageMonthly: null };
  }

  return {
    hasObservations: true,
    thisMonth: amounts[amounts.length - 1],
    averageMonthly: Math.round(amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length),
  };
}
