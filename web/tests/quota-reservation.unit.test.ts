/**
 * Focused tests for reservation/commit/release semantics in src/lib/quota.ts
 * (issue #1328).
 *
 * Covers:
 *   – reserveQuota: succeeds when capacity is available
 *   – reserveQuota: returns ok:false when limit is exceeded
 *   – reserveQuota: concurrent reservations prevent overspend
 *   – commitReservation: converts reservation to committed usage
 *   – commitReservation: returns ok:false for unknown reservation ID
 *   – releaseReservation: removes the reservation, restoring capacity
 *   – releaseReservation: idempotent — double-release does not throw
 *   – quota disabled → reserve always returns ok:true
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.where = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  function makeInsertChain(returningRows: unknown[] = []) {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(() => chain);
    chain.onConflictDoUpdate = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returningRows));
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  const dbInsert = vi.fn(() => makeInsertChain([{ count: 1 }]));

  return { dbSelect, dbInsert, makeSelectChain, makeInsertChain };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/db/schema", () => ({
  tlsQuotaConfigs: { talosId: "talosId", resource: "resource" },
  tlsQuotaUsage: {
    talosId: "talosId",
    resource: "resource",
    windowStart: "windowStart",
    count: "count",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((col: string, val: unknown) => ({ op: "eq", col, val })),
  isNull: vi.fn((col: string) => ({ op: "isNull", col })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  sql: new Proxy(() => {}, {
    apply: (_t, _this, args) => ({ op: "sql", args }),
    get: (_t, p) => (p === "raw" ? vi.fn() : undefined),
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  reserveQuota,
  commitReservation,
  releaseReservation,
  _resetReservationsForTests,
  type QuotaResource,
} from "@/lib/quota";

// ── Fake DB ───────────────────────────────────────────────────────────────────

const fakeDb = {
  select: mocks.dbSelect,
  insert: mocks.dbInsert,
} as unknown as Parameters<typeof reserveQuota>[0];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a resolved config row for the select chain (tlsQuotaConfigs lookup). */
function makeConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    talosId: "agent-1",
    resource: "activity_writes" as QuotaResource,
    maxCount: 10,
    windowSize: "daily",
    enabled: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Wire up the DB mocks for a single reserveQuota call:
 *  1st select → config rows (resolveQuotaConfig)
 *  2nd select → usage row (current committed count)
 */
function wireReserve(configRow: ReturnType<typeof makeConfigRow>, committedCount: number) {
  // resolveQuotaConfig select
  mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
  // usage select
  const usageResult = committedCount > 0 ? [{ count: committedCount }] : [];
  mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain(usageResult));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetReservationsForTests();
  mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
  mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));
});

// ─── reserveQuota ─────────────────────────────────────────────────────────────

describe("reserveQuota", () => {
  it("returns ok:true and a non-empty reservationId when capacity is available", async () => {
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0); // 0 committed so far

    const result = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(true);
    expect(result.reservationId).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(result.limit).toBe(10);
    expect(result.resource).toBe("activity_writes");
  });

  it("returns ok:false when committed usage already exhausts the limit", async () => {
    const config = makeConfigRow({ maxCount: 5 });
    wireReserve(config, 5); // already at limit

    const result = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(false);
    expect(result.reservationId).toBe("");
    expect(result.remaining).toBe(0);
  });

  it("returns ok:false when committed + this reservation would exceed the limit", async () => {
    const config = makeConfigRow({ maxCount: 5 });
    wireReserve(config, 4); // 4 committed, requesting 2 more → would be 6 > 5

    const result = await reserveQuota(fakeDb, "agent-1", "activity_writes", 2);

    expect(result.ok).toBe(false);
  });

  it("two concurrent reservations cannot both succeed for the last slot", async () => {
    const config = makeConfigRow({ maxCount: 3 });

    // First reservation — 1 committed, 2 remaining → succeeds
    wireReserve(config, 1);
    const r1 = await reserveQuota(fakeDb, "agent-1", "activity_writes");
    expect(r1.ok).toBe(true);

    // Second reservation — 1 committed + 1 pending, 1 remaining → succeeds
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([config]));
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([{ count: 1 }]));
    const r2 = await reserveQuota(fakeDb, "agent-1", "activity_writes");
    expect(r2.ok).toBe(true);

    // Third reservation — 1 committed + 2 pending = 3, no room → rejected
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([config]));
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([{ count: 1 }]));
    const r3 = await reserveQuota(fakeDb, "agent-1", "activity_writes");
    expect(r3.ok).toBe(false);
  });

  it("returns ok:true with a reservationId when quota is disabled", async () => {
    // No config rows → hard-coded disabled fallback
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([]));

    const result = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(true);
    expect(result.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    // No usage select should have been made (disabled path skips it)
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
  });

  it("returns a resetAt timestamp in the future", async () => {
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);

    const before = Date.now();
    const result = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.resetAt).toBeGreaterThan(before);
  });
});

// ─── commitReservation ────────────────────────────────────────────────────────

describe("commitReservation", () => {
  it("returns ok:true and triggers a usage increment", async () => {
    // Reserve first
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    // Commit — checkAndIncrementQuota needs: config select + insert
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([config]));
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 1 }]));

    const result = await commitReservation(fakeDb, "agent-1", "activity_writes", reservationId);

    expect(result.ok).toBe(true);
    expect(result.reservationId).toBe(reservationId);
    expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false for an unknown reservation ID", async () => {
    const result = await commitReservation(fakeDb, "agent-1", "activity_writes", "no-such-id");

    expect(result.ok).toBe(false);
    expect(result.reservationId).toBe("no-such-id");
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("returns ok:false when the reservation belongs to a different agent", async () => {
    // Reserve as agent-1
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    // Try to commit as agent-2
    const result = await commitReservation(fakeDb, "agent-2", "activity_writes", reservationId);

    expect(result.ok).toBe(false);
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("is not reusable — second commit on same ID returns ok:false", async () => {
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    // First commit
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([config]));
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 1 }]));
    await commitReservation(fakeDb, "agent-1", "activity_writes", reservationId);

    // Second commit on the same ID must fail
    const second = await commitReservation(fakeDb, "agent-1", "activity_writes", reservationId);
    expect(second.ok).toBe(false);
  });
});

// ─── releaseReservation ───────────────────────────────────────────────────────

describe("releaseReservation", () => {
  it("removes the reservation and restores capacity for the next reserveQuota call", async () => {
    const config = makeConfigRow({ maxCount: 1 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    // Release
    const rel = await releaseReservation("agent-1", "activity_writes", reservationId);
    expect(rel.ok).toBe(true);

    // The released slot is now available again
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([config]));
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([])); // 0 committed
    const r2 = await reserveQuota(fakeDb, "agent-1", "activity_writes");
    expect(r2.ok).toBe(true);
  });

  it("returns ok:true for an unknown ID (idempotent)", async () => {
    const result = await releaseReservation("agent-1", "activity_writes", "ghost-id");
    expect(result.ok).toBe(true);
  });

  it("double-release does not throw and returns ok:true both times", async () => {
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    const r1 = await releaseReservation("agent-1", "activity_writes", reservationId);
    const r2 = await releaseReservation("agent-1", "activity_writes", reservationId);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // idempotent
  });

  it("released reservation cannot be committed afterwards", async () => {
    const config = makeConfigRow({ maxCount: 10 });
    wireReserve(config, 0);
    const { reservationId } = await reserveQuota(fakeDb, "agent-1", "activity_writes");

    await releaseReservation("agent-1", "activity_writes", reservationId);

    const commitResult = await commitReservation(
      fakeDb,
      "agent-1",
      "activity_writes",
      reservationId,
    );
    expect(commitResult.ok).toBe(false);
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });
});
