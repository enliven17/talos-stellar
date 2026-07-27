/**
 * Pure-helper unit tests for web/src/lib/budgets/reconciliation.ts
 *
 * These tests deliberately do not import the db, logger, or any side
 * effect — they exercise the snowflake-free math that drives every
 * other budget path.  Run them in any environment without dependencies.
 */

import { describe, it, expect } from "vitest";
import {
  toBigInt,
  formatMinor,
  parseMinor,
  computeBudgetAvailability,
  classifyExpired,
  isTerminalState,
  isReleaseState,
  isValidReservationTransition,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  RELEASE_STATES,
} from "../src/lib/budgets/reconciliation";

const NOW = new Date("2026-07-26T12:00:00.000Z");

describe("toBigInt", () => {
  it("accepts values from bigint, integer numbers, and integer strings", () => {
    expect(toBigInt(42n)).toBe(42n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt("42")).toBe(42n);
    expect(toBigInt("0")).toBe(0n);
    expect(toBigInt("-1")).toBe(-1n);
  });

  it("trims whitespace around integer strings", () => {
    expect(toBigInt(" 12 ")).toBe(12n);
  });

  it("rejects non-integer numbers", () => {
    expect(() => toBigInt(1.5)).toThrow(/non-integer/);
    expect(() => toBigInt(Number.NaN)).toThrow(/non-integer/);
    expect(() => toBigInt(Number.POSITIVE_INFINITY)).toThrow(/non-integer/);
  });

  it("rejects float strings and empty inputs", () => {
    expect(() => toBigInt("1.5")).toThrow(/invalid integer string/);
    expect(() => toBigInt("")).toThrow(/invalid integer string/);
    expect(() => toBigInt("abc")).toThrow(/invalid integer string/);
    expect(() => toBigInt(null)).toThrow(/null/);
    expect(() => toBigInt(undefined)).toThrow(/null/);
  });
});

describe("formatMinor / parseMinor round-trips", () => {
  it("formats integer minor units with the configured decimal precision", () => {
    expect(formatMinor(1_000_000n)).toBe("1.000000");
    expect(formatMinor(1n, 6)).toBe("0.000001");
    expect(formatMinor(0n, 6)).toBe("0.000000");
  });

  it("formats negative amounts with a leading minus sign", () => {
    expect(formatMinor(-100_500_000n)).toBe("-100.500000");
  });

  it("parseMinor + formatMinor is the identity for valid forms", () => {
    const cases = ["0.000000", "1.000000", "0.012345", "100.500000", "9999.999999"];
    for (const c of cases) {
      expect(formatMinor(parseMinor(c))).toBe(c);
    }
  });

  it("rejects malformed inputs", () => {
    expect(() => parseMinor("not-a-number")).toThrow();
    expect(() => parseMinor("")).toThrow();
    expect(() => parseMinor("1")).toThrow(); // requires fractional part
  });
});

describe("computeBudgetAvailability — non-rolling global scope", () => {
  const baseBudget = () => ({
    id: "budget_1",
    limitAmount: 10_000_000n, // $10.00
    windowSeconds: null,
    enabled: true,
  });

  it("returns the full limit when there are no reservations or events", () => {
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [],
        events: [],
        now: NOW,
      }),
    ).toBe(10_000_000n);
  });

  it("subtracts the amount of an active (non-expired) reservation", () => {
    const r = {
      id: "res_1",
      budgetId: "budget_1",
      amount: 2_500_000n,
      status: "reserved" as const,
      // not yet expired
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 5_000),
    };
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [r],
        events: [],
        now: NOW,
      }),
    ).toBe(7_500_000n);
  });

  it("encumbers reserved + committed + settled; ignores release/refund/expired", () => {
    const encumbered = [
      { status: "reserved"  as const,  amount: 1_000_000n },
      { status: "committed" as const,  amount: 2_000_000n },
      { status: "settled"   as const,  amount: 3_000_000n },
    ];
    const notEncumbered = [
      { status: "released"  as const,  amount: 4_000_000n },
      { status: "expired"   as const,  amount: 5_000_000n },
      { status: "refunded"  as const,  amount: 6_000_000n },
    ];
    const reservations = [...encumbered, ...notEncumbered].map((r, i) => ({
      id: `res_${i}`,
      budgetId: "budget_1",
      amount: r.amount,
      status: r.status,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 100),
    }));
    // Sum of encumbered = 1 + 2 + 3 = 6M; available = 10M − 6M = 4M
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations,
        events: [],
        now: NOW,
      }),
    ).toBe(4_000_000n);
  });

  it("treats reservations past their expiresAt as expired and frees their funds", () => {
    const r = {
      id: "res_expired",
      budgetId: "budget_1",
      amount: 9_000_000n,
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() - 1), // 1ms ago — expired
      createdAt: new Date(NOW.getTime() - 5_000),
    };
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [r],
        events: [],
        now: NOW,
      }),
    ).toBe(10_000_000n);
  });

  it("does NOT count commit/settle events as spend (reservation status drives accounting)", () => {
    // Design: events are audit-only.  Spend derives solely from the
    // reservation ledger (status ∈ {reserved, committed, settled}).
    // Counting both commit + settle events would double-spend a single
    // reservation that walks reserved → committed → settled.
    const events = [
      { id: "e_commit", budgetId: "budget_1", reservationId: "r1", kind: "commit",  amount: 9_000_000n, createdAt: new Date(NOW.getTime() - 100) },
      { id: "e_settle", budgetId: "budget_1", reservationId: "r1", kind: "settle",  amount: 9_000_000n, createdAt: new Date(NOW.getTime() - 100) },
    ];
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [],
        events,
        now: NOW,
      }),
    ).toBe(10_000_000n); // no encumbered reservations → full limit available
  });

  it("does NOT double-count reserve events when the reservation row is present", () => {
    const r = {
      id: "res_1",
      budgetId: "budget_1",
      amount: 4_000_000n,
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 100),
    };
    const events = [
      { id: "e1", budgetId: "budget_1", reservationId: "res_1", kind: "reserve", amount: 4_000_000n, createdAt: new Date(NOW.getTime() - 100) },
    ];
    // Available = limit − reservation's amount (events not summed)
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [r],
        events,
        now: NOW,
      }),
    ).toBe(6_000_000n);
  });

  it("still counts orphan reserve events (no reservation row) — defensive", () => {
    const events = [
      { id: "e1", budgetId: "budget_1", reservationId: null, kind: "reserve", amount: 10_000_000n, createdAt: new Date(NOW.getTime() - 100) },
    ];
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [],
        events,
        now: NOW,
      }),
    ).toBe(0n);
  });

  it("encumbers committed/settled reservations and ignores expired-only 'reserved' rows", () => {
    const base = baseBudget();
    const rows = [
      { id: "r1", budgetId: "budget_1", amount: 1_000_000n, status: "committed" as const,
        expiresAt: null, createdAt: new Date(NOW.getTime() - 100) },
      { id: "r2", budgetId: "budget_1", amount: 2_000_000n, status: "reserved"   as const,
        expiresAt: new Date(NOW.getTime() - 1), createdAt: new Date(NOW.getTime() - 100) },
    ];
    expect(
      computeBudgetAvailability({ budget: base, reservations: rows, events: [], now: NOW }),
    ).toBe(9_000_000n); // 1M committed + 0 (expired reserved)
  });

  it("clamps to zero when overshoot would go negative", () => {
    const r = {
      id: "res_huge",
      budgetId: "budget_1",
      amount: 20_000_000n, // larger than limit
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 100),
    };
    expect(
      computeBudgetAvailability({
        budget: baseBudget(),
        reservations: [r],
        events: [],
        now: NOW,
      }),
    ).toBe(0n);
  });

  it("rejects negative limit", () => {
    expect(() =>
      computeBudgetAvailability({
        budget: { ...baseBudget(), limitAmount: -1n },
        reservations: [],
        events: [],
        now: NOW,
      }),
    ).toThrow(/non-negative/);
  });
});

describe("computeBudgetAvailability — rolling window scope", () => {
  const window = (seconds: number) => ({
    id: "budget_rolling",
    limitAmount: 10_000_000n,
    windowSeconds: seconds,
    enabled: true,
  });

  it("excludes reservations created before the rolling window", () => {
    const r = {
      id: "res_old",
      budgetId: "budget_rolling",
      amount: 9_999_999n,
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 5 * 60 * 1000), // 5 min ago
    };
    expect(
      computeBudgetAvailability({
        budget: window(60),        // 1 minute window
        reservations: [r],
        events: [],
        now: NOW,
      }),
    ).toBe(10_000_000n);
  });

  it("includes reservations created within the rolling window", () => {
    const r = {
      id: "res_new",
      budgetId: "budget_rolling",
      amount: 2_000_000n,
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 5_000),
    };
    expect(
      computeBudgetAvailability({
        budget: window(60),
        reservations: [r],
        events: [],
        now: NOW,
      }),
    ).toBe(8_000_000n);
  });

  it("computes separate rolling buckets (daily vs hourly)", () => {
    const recent = {
      id: "res_recent", budgetId: "budget_rolling", amount: 1_000_000n,
      status: "reserved" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 30_000),
    };

    // Hourly bucket: only counts usage ≤ 1h old
    expect(
      computeBudgetAvailability({
        budget: window(3600),
        reservations: [recent],
        events: [],
        now: NOW,
      }),
    ).toBe(9_000_000n);

    // Daily bucket: 1M in last 30s is far less than 24h, so still counts
    expect(
      computeBudgetAvailability({
        budget: window(86_400),
        reservations: [recent],
        events: [],
        now: NOW,
      }),
    ).toBe(9_000_000n);
  });
});

describe("classifyExpired", () => {
  it("returns expired for past expiresAt + reserved status", () => {
    expect(
      classifyExpired(
        {
          id: "r", budgetId: "b", amount: 1n, status: "reserved",
          expiresAt: new Date(NOW.getTime() - 1),
          createdAt: new Date(NOW.getTime() - 100),
        },
        NOW,
      ),
    ).toBe("expired");
  });

  it("keeps the original state when not yet expired", () => {
    expect(
      classifyExpired(
        {
          id: "r", budgetId: "b", amount: 1n, status: "reserved",
          expiresAt: new Date(NOW.getTime() + 1),
          createdAt: new Date(NOW.getTime() - 100),
        },
        NOW,
      ),
    ).toBe("reserved");
  });

  it("does not change terminal states", () => {
    expect(
      classifyExpired(
        {
          id: "r", budgetId: "b", amount: 1n, status: "settled",
          expiresAt: new Date(NOW.getTime() - 1),
          createdAt: new Date(NOW.getTime() - 100),
        },
        NOW,
      ),
    ).toBe("settled");
  });
});

describe("state machine", () => {
  it("flags terminal and release states correctly", () => {
    for (const s of ["released", "expired", "refunded"] as const) {
      expect(isTerminalState(s)).toBe(true);
      expect(isReleaseState(s)).toBe(true);
    }
    expect(isTerminalState("settled")).toBe(false);
    expect(isReleaseState("settled")).toBe(false);
    expect(TERMINAL_STATES.has("refunded")).toBe(true);
    expect(RELEASE_STATES.has("settled")).toBe(false);
  });

  it("only permits sanctioned transitions", () => {
    expect(isValidReservationTransition("reserved", "committed")).toBe(true);
    expect(isValidReservationTransition("reserved", "released")).toBe(true);
    expect(isValidReservationTransition("committed", "settled")).toBe(true);
    expect(isValidReservationTransition("settled", "refunded")).toBe(true);

    // Illegal transitions
    expect(isValidReservationTransition("released", "settled")).toBe(false);
    expect(isValidReservationTransition("expired", "committed")).toBe(false);
    expect(isValidReservationTransition("settled", "reserved")).toBe(false);
    expect(isValidReservationTransition("refunded", "committed")).toBe(false);

    // State machine sanity
    expect(VALID_TRANSITIONS.released).toEqual([]);
    expect(VALID_TRANSITIONS.expired).toEqual([]);
    expect(VALID_TRANSITIONS.refunded).toEqual([]);
  });
});
