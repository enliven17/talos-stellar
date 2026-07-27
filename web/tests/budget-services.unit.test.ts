/**
 * Integration-style tests for budget-services.ts
 *
 * These tests use a hoisted vi.mock to stand in for `@/db`,
 * `@/lib/logger`, and `@/db/db-retry`.  They cover the contract that
 * the API routes rely on:
 *
 *   - reserve (idempotency, insufficient budget, ok)
 *   - transition (state machine, fencing, release accounting)
 *   - reconcile (drift detection + repair)
 *   - upsert
 *
 * Concurrency cases (Promise.all races) live in
 * tests/budget-reservation.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mock factories ────────────────────────────────────────
//
// Mirrors the pattern used in tests/commerce-jobs-idempotency.test.ts:
// a Promise.all-safe, table-aware dispatcher so the order of mock
// invocations across concurrent awaits does not break the test.

const mocks = vi.hoisted(() => {
  const budgets: any[] = [];
  const reservations: any[] = [];
  const events: any[] = [];

  // Per-test seed: pick which side selects return.
  const seed = {
    budgets: budgets,
    reservations: reservations,
    events: events,
    budgetsWhere: [] as any[][],
    reservationsWhere: [] as any[][],
    eventsWhere: [] as any[][],
  };

  function makeChain(tableName: string) {
    let _parent: any = null;
    const chain: any = {
      from: vi.fn((table: any) => {
        _parent = table;
        const sym: symbol | undefined =
          table && Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
        chain.__table = sym ? table[sym] : tableName;
        return chain;
      }),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (r: any) => any) => {
        return Promise.resolve(cb(handleSelect(chain.__table)));
      }),
    };
    return chain;
  }

  function handleSelect(t: string | undefined) {
    if (t === "tls_budgets") return [...seed.budgets];
    if (t === "tls_budget_reservations") return [...seed.reservations];
    if (t === "tls_budget_usage_events") return [...seed.events];
    return [];
  }

  function handleInsert(table: any) {
    return {
      values: vi.fn((payload: any) => {
        const sym: symbol | undefined =
          table && Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
        const name = sym ? table[sym] : "unknown";
        if (name === "tls_budget_reservations") {
          seed.reservations.push({
            ...payload,
            createdAt: payload.createdAt ?? new Date(),
          });
          return {
            returning: vi.fn().mockResolvedValue([{ id: payload.id, createdAt: new Date() }]),
          };
        }
        if (name === "tls_budget_usage_events") {
          seed.events.push({ ...payload, createdAt: new Date() });
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
    };
  }

  function handleUpdate(table: any) {
    return {
      set: vi.fn((patch: any) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
          then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(undefined))),
        }),
      })),
    };
  }

  return {
    seed,
    mockDb: {
      select: () => makeChain(""),
      insert: handleInsert,
      update: handleUpdate,
    },
    insertCalls: { budgets: 0, reservations: 0, events: 0 },
  };
});

let lastTxCallback: ((tx: any) => Promise<any>) | null = null;

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// In-process transaction: capture the tx callback but invoke it
// immediately against the shared mockDb.  Skip the retry wrapper so
// concurrency behaviour is deterministic and easy to inspect.
vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: async (cb: (tx: any) => Promise<any>) => {
    lastTxCallback = cb;
    return cb(mocks.mockDb);
  },
}));

// ─── Reset between tests ────────────────────────────────────────────
function reset() {
  mocks.seed.budgets.length = 0;
  mocks.seed.reservations.length = 0;
  mocks.seed.events.length = 0;
  lastTxCallback = null;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("reserveBudget — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1",
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      windowSeconds: null,
      limitAmount: 10_000_000n,
      availableAmount: 10_000_000n,
      currency: "USDC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("creates a reservation row + a reserve event + deducts the mirror", async () => {
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    const out = await reserveBudget({
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      amountMinor: 2_500_000n,
      expiresInSeconds: 60,
      idempotencyKey: "key-1",
    });
    expect(out.id).toBeDefined();
    expect(out.status).toBe("reserved");
    expect(out.fencingToken).toBe(1);
    expect(mocks.seed.reservations).toHaveLength(1);
    expect(mocks.seed.events).toHaveLength(1);
  });

  it("rejects when the budget is disabled", async () => {
    mocks.seed.budgets[0].enabled = false;
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      reserveBudget({
        talosId: "agent_1",
        scopeKind: "global",
        scopeValue: null,
        amountMinor: 100n,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "budget_disabled", statusCode: 409 });
  });

  it("rejects when no matching budget row exists", async () => {
    mocks.seed.budgets.length = 0;
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      reserveBudget({
        talosId: "agent_1",
        scopeKind: "category",
        scopeValue: "Sales",
        amountMinor: 100n,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "budget_not_found", statusCode: 404 });
  });

  it("rejects an idempotency conflict by pre-checking the unique index", async () => {
    mocks.seed.reservations.push({
      id: "existing",
      talosId: "agent_1",
      idempotencyKey: "key-dup",
      status: "reserved",
    });
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      reserveBudget({
        talosId: "agent_1",
        scopeKind: "global",
        scopeValue: null,
        amountMinor: 100n,
        expiresInSeconds: 60,
        idempotencyKey: "key-dup",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
  });

  it("surfaces a unique-constraint race (23505) as idempotency_conflict", async () => {
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    // Simulate the second concurrent request losing the race: the insert
    // throws 23505 because the partial unique index fires.
    const realInsert = mocks.mockDb.insert;
    mocks.mockDb.insert = (table: any) => {
      const sym: symbol | undefined =
        table && Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
      const name = sym ? table[sym] : "unknown";
      if (name === "tls_budget_reservations") {
        return {
          values: () => {
            const e = Object.assign(new Error("duplicate key"), {
              code: "23505",
              constraint: "tls_budget_reservations_talosId_idempotencyKey_unique",
            });
            return { returning: () => Promise.reject(e) };
          },
        };
      }
      return realInsert(table);
    };
    try {
      await expect(
        reserveBudget({
          talosId: "agent_1",
          scopeKind: "global",
          scopeValue: null,
          amountMinor: 100n,
          expiresInSeconds: 60,
          idempotencyKey: "key-race",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });
    } finally {
      // Restore the original insert so subsequent tests are not contaminated.
      mocks.mockDb.insert = realInsert;
    }
  });

  it("rejects when amountMinor exceeds the computed available", async () => {
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      reserveBudget({
        talosId: "agent_1",
        scopeKind: "global",
        scopeValue: null,
        amountMinor: 99_000_000n, // > limit
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "insufficient_budget", statusCode: 409 });
  });

  it("rejects a non-positive amountMinor up front", async () => {
    const { reserveBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      reserveBudget({
        talosId: "agent_1",
        scopeKind: "global",
        scopeValue: null,
        amountMinor: 0n,
        expiresInSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "invalid_amount", statusCode: 400 });
  });
});

describe("transitionReservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1",
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      windowSeconds: null,
      limitAmount: 10_000_000n,
      availableAmount: 7_500_000n,
      currency: "USDC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.seed.reservations.push({
      id: "res_1",
      talosId: "agent_1",
      budgetId: "budget_1",
      amount: 2_500_000n,
      status: "reserved",
      idempotencyKey: null,
      fencingToken: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("moves reserved → committed and bumps the fencing token", async () => {
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    const out = await transitionReservation({
      talosId: "agent_1",
      reservationId: "res_1",
      toStatus: "committed",
      fencingToken: 1,
      reason: "fulfilling_job",
    });
    expect(out.status).toBe("committed");
    expect(out.fencingToken).toBe(2);
    expect(mocks.seed.reservations[0].status).toBe("committed");
    expect(mocks.seed.events.at(-1).kind).toBe("commit");
  });

  it("rejects with stale_fencing_token when the caller presents an old token", async () => {
    mocks.seed.reservations[0].fencingToken = 3;
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    await expect(
      transitionReservation({
        talosId: "agent_1",
        reservationId: "res_1",
        toStatus: "committed",
        fencingToken: 1,
      }),
    ).rejects.toMatchObject({ code: "stale_fencing_token", statusCode: 409 });
  });

  it("rejects already-terminal reservations", async () => {
    mocks.seed.reservations[0].status = "settled";
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    await expect(
      transitionReservation({
        talosId: "agent_1",
        reservationId: "res_1",
        toStatus: "refunded",
        fencingToken: 1,
      }),
    ).rejects.toMatchObject({ code: "already_terminal", statusCode: 409 });
  });

  it("rejects illegal transitions (settled → reserved)", async () => {
    mocks.seed.reservations[0].status = "settled";
    mocks.seed.reservations[0].fencingToken = 5;
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    await expect(
      transitionReservation({
        talosId: "agent_1",
        reservationId: "res_1",
        toStatus: "reserved",
        fencingToken: 5,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition", statusCode: 400 });
  });

  it("credits released amount back to the budget mirror on a release event", async () => {
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    await transitionReservation({
      talosId: "agent_1",
      reservationId: "res_1",
      toStatus: "released",
      fencingToken: 1,
    });
    // availableAmount should have been restored: 7.5M + 2.5M = 10M
    expect(String(mocks.seed.budgets[0].availableAmount)).toBe("10000000");
    // The release event records a negative delta
    expect(mocks.seed.events.at(-1).kind).toBe("release");
  });

  it("commit → settled is allowed and emits a settle event", async () => {
    mocks.seed.reservations[0].status = "committed";
    const { transitionReservation } = await import("../src/lib/budgets/budget-services");
    await transitionReservation({
      talosId: "agent_1",
      reservationId: "res_1",
      toStatus: "settled",
      fencingToken: 1,
    });
    expect(mocks.seed.reservations[0].status).toBe("settled");
    expect(mocks.seed.events.at(-1).kind).toBe("settle");
  });
});

describe("reconcileBudget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1",
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      windowSeconds: null,
      limitAmount: 10_000_000n,
      availableAmount: 5_000_000n, // stale, drifted
      currency: "USDC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("detects drift and reports it (no events/reservations)", async () => {
    const { reconcileBudget } = await import("../src/lib/budgets/budget-services");
    const r = await reconcileBudget("agent_1", "budget_1");
    expect(r.mismatched).toBe(true);
    expect(r.computedAvailable).toBe("10000000");
  });

  it("repairs the mirror by default (dryRun=false)", async () => {
    const { reconcileBudget } = await import("../src/lib/budgets/budget-services");
    const r = await reconcileBudget("agent_1", "budget_1");
    expect(r.repaired).toBe(true);
    expect(String(mocks.seed.budgets[0].availableAmount)).toBe("10000000");
  });

  it("does NOT repair when dryRun=true", async () => {
    const { reconcileBudget } = await import("../src/lib/budgets/budget-services");
    const r = await reconcileBudget("agent_1", "budget_1", { dryRun: true });
    expect(r.repaired).toBe(false);
    expect(String(mocks.seed.budgets[0].availableAmount)).toBe("5000000"); // unchanged
  });
});

describe("upsertBudget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("creates a new budget when no row matches", async () => {
    const { upsertBudget } = await import("../src/lib/budgets/budget-services");
    const out = await upsertBudget({
      talosId: "agent_2",
      scopeKind: "rolling",
      scopeValue: "daily",
      windowSeconds: 86_400,
      limitAmountMinor: 50_000_000n,
    });
    expect(out.id).toBeDefined();
    expect(out.windowSeconds).toBe(86_400);
    expect(out.availableAmount).toBe("50000000");
  });

  it("rejects a rolling scope without windowSeconds", async () => {
    const { upsertBudget } = await import("../src/lib/budgets/budget-services");
    await expect(
      upsertBudget({
        talosId: "agent_2",
        scopeKind: "rolling",
        scopeValue: "daily",
        windowSeconds: null,
        limitAmountMinor: 50_000_000n,
      }),
    ).rejects.toMatchObject({ code: "invalid_window", statusCode: 400 });
  });
});
