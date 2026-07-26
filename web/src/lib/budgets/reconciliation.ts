/**
 * A2A Budget — Pure Reconciliation Helpers
 * ──────────────────────────────────────────
 *
 * Snowflake-free functions that compute the canonical "available"
 * amount for a budget, classify expired reservations, format minor
 * units, etc.  These are deliberately side-effect free so they can be
 * unit-tested without an HTTP server or DB connection, and so the
 * reconciler route can call them from any environment.
 *
 * Why pure?
 *   - Replay-safe: same `(events, reservations, now)` → same answer.
 *   - Auditable: ops can drop the function output alongside the events
 *     table and verify the math is consistent.
 *   - Composable: the budget-service module calls these inside a
 *     transaction, and the route-level reconciler calls them again
 *     outside the transaction to detect drift.
 *
 * The companion doc-table (`tls_budget_usage_events`) is authoritative;
 * any divergence with `tls_budgets.availableAmount` is surfaced and
 * repaired during reconciliation.  See web/drizzle/0014_add_budget_reservations.sql
 * for the storage layout and BUDGETS.md for the lifecycle contract.
 */

export type ReservationState =
  | "reserved"
  | "committed"
  | "settled"
  | "released"
  | "expired"
  | "refunded";

export type UsageEventKind =
  | "reserve"
  | "commit"
  | "settle"
  | "refund"
  | "expire"
  | "release"
  | "reject";

/** State machine — what transitions are legal. */
export const VALID_TRANSITIONS: Record<ReservationState, ReservationState[]> = {
  reserved: ["committed", "settled", "released", "expired", "refunded"],
  committed: ["settled", "released", "refunded"],
  settled: ["refunded"],
  released: [],
  expired: [],
  refunded: [],
};

export const TERMINAL_STATES = new Set<ReservationState>([
  "released",
  "expired",
  "refunded",
]);

/** Transitions that release reserved funds back to the budget. */
export const RELEASE_STATES = new Set<ReservationState>([
  "released",
  "expired",
  "refunded",
]);

export interface ReservationRow {
  id: string;
  budgetId: string;
  amount: bigint | number | string;
  status: ReservationState | string;
  expiresAt: Date | string | null;
  createdAt: Date | string;
}

export interface BudgetRow {
  id: string;
  limitAmount: bigint | number | string;
  windowSeconds: number | null;
  enabled: boolean;
}

export interface UsageEventRow {
  id: string;
  budgetId: string;
  reservationId: string | null;
  kind: string;
  amount: bigint | number | string;
  createdAt: Date | string;
}

const ZERO = 0n;

/**
 * Coerce a numeric value into BigInt safely.  Throws a TypeError-style
 * Error with a descriptive message instead of returning NaN/Infinity.
 */
export function toBigInt(v: bigint | number | string | null | undefined): bigint {
  if (v === null || v === undefined) {
    throw new Error("toBigInt: value is null/undefined");
  }
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(
        `toBigInt: non-integer or non-finite number ${JSON.stringify(v)}`,
      );
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    // Allow optional leading "-" for signed deltas, but reject floats and
    // empty strings.  We never want to silently drop precision.
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(trimmed)) {
      throw new Error(
        `toBigInt: invalid integer string "${v}" (must match /^-?(0|[1-9]\\d*)$/)`,
      );
    }
    return BigInt(trimmed);
  }
  throw new Error(`toBigInt: unsupported type ${typeof v}`);
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/** Convenience: deterministic date parsing used by the reconciler. */
function dateMs(v: Date | string | null | undefined, fallback = 0): number {
  const d = toDate(v);
  return d ? d.getTime() : fallback;
}

/**
 * Reservation statuses that hold funds encumbered against the budget.
 * Committed and settled reservations continue to encumber the limit; the
 * funds are "spent" at the `settle` event, not on commit, so we don't
 * double-count by summing both event kinds.
 */
export const ENCUMBERED_STATES: ReadonlySet<ReservationState> = new Set<ReservationState>([
  "reserved",
  "committed",
  "settled",
]);

/**
 * Recompute the currently-available amount for a budget from scratch,
 * using only the reservation ledger and the event log.
 *
 * Algorithm:
 *   1. If a rolling window is configured, restrict consideration to rows
 *      whose `createdAt` falls within `[now - windowSeconds, now]`.
 *   2. Sum the minor-unit `amount` of every reservation whose status is
 *      in ENCUMBERED_STATES (reserved / committed / settled).  Active
 *      'reserved' rows past their expiresAt are excluded — they are
 *      treated as expired without mutating state.
 *   3. Defensively, add any 'reserve' event whose reservationId column
 *      is NULL — this catches the rare case where the reservation row
 *      was lost but the event was kept (audit-trail-only invariant).
 *   4. `available = max(0, limit - used)`.
 *
 * Pure: passes `now` instead of reading the wall clock, so the same input
 *                produces the same output on every replay.
 */
export function computeBudgetAvailability(args: {
  budget: BudgetRow;
  reservations: ReservationRow[];
  events: UsageEventRow[];
  now: Date;
}): bigint {
  const limit = toBigInt(args.budget.limitAmount);
  if (limit < 0n) {
    throw new Error("budget.limitAmount must be non-negative");
  }
  const nowMs = args.now.getTime();
  const cutoffMs =
    args.budget.windowSeconds != null && args.budget.windowSeconds > 0
      ? nowMs - args.budget.windowSeconds * 1000
      : null;

  let used: bigint = ZERO;

  for (const r of args.reservations) {
    if (cutoffMs !== null && dateMs(r.createdAt) < cutoffMs) continue;
    const status = String(r.status) as ReservationState;
    if (!ENCUMBERED_STATES.has(status)) continue;
    const amount = toBigInt(r.amount);
    if (amount === ZERO) continue;
    // Past-expiry 'reserved' rows are treated as expired and freed.
    if (status === "reserved") {
      const expires = dateMs(r.expiresAt, Number.POSITIVE_INFINITY);
      if (expires <= nowMs) continue;
    }
    used += amount;
  }

  // Defensive: orphan 'reserve' events with no matching reservation row
  // represent encumbered spend the reconciler cannot derive from the
  // reservation ledger.  We credit the spend so the bookkeeping remains
  // balanced (e.g. manual rollback, replication drift).  commit / settle /
  // refund / release events are audit-only and not summed here — the
  // reservation's encumbered status above already captures spend.
  for (const e of args.events) {
    if (cutoffMs !== null && dateMs(e.createdAt) < cutoffMs) continue;
    if (e.kind === "reserve" && e.reservationId == null) {
      used += toBigInt(e.amount);
    }
  }

  return used >= limit ? ZERO : limit - used;
}

/**
 * Snap a reservation to a terminal "expired" state if its `expiresAt`
 * has elapsed and the row is still logically 'reserved'.
 *
 * Pure classifier — does not mutate the input.
 */
export function classifyExpired(
  reservation: ReservationRow,
  now: Date,
): ReservationState {
  const status = String(reservation.status) as ReservationState;
  if (status !== "reserved") return status;
  const expires = dateMs(reservation.expiresAt, Number.POSITIVE_INFINITY);
  if (expires <= now.getTime()) {
    return "expired";
  }
  return status;
}

export function isTerminalState(s: ReservationState): boolean {
  return TERMINAL_STATES.has(s);
}

export function isReleaseState(s: ReservationState): boolean {
  return RELEASE_STATES.has(s);
}

export function isValidReservationTransition(
  from: ReservationState,
  to: ReservationState,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Format a BigInt minor-unit amount as a fixed-decimal,
 * human-readable string.  Defaults to 6 fractional digits
 * (the Stellar USDC convention).  Negative amounts are
 * formatted with a leading minus sign.
 */
export function formatMinor(amount: bigint, decimals = 6): string {
  const neg = amount < ZERO;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Parse a human "0.012345" string into a BigInt minor-unit amount. */
export function parseMinor(human: string, decimals = 6): bigint {
  if (typeof human !== "string" || human.length === 0) {
    throw new Error("parseMinor: empty input");
  }
  const m = /^-?(\d+)\.(\d+)$/.exec(human.trim());
  if (!m) {
    // Reject integers without a decimal part to keep the format uniform.
    throw new Error(
      `parseMinor: expected "<int>.<frac>" with ${decimals} decimals, got "${human}"`,
    );
  }
  const sign = human.startsWith("-") ? -1n : 1n;
  const whole = BigInt(m[1]!);
  const fracStr = (m[2]! + "0".repeat(decimals)).slice(0, decimals);
  const frac = BigInt(fracStr);
  return sign * (whole * 10n ** BigInt(decimals) + frac);
}
