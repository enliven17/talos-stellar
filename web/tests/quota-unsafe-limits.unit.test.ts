/**
 * Focused tests for unsafe-limit validation in src/lib/quota.ts (issue #1330).
 *
 * Covers:
 *   – validateQuotaLimit: valid and invalid inputs
 *   – resolveQuotaConfig: throws QuotaConfigError for unsafe agentRow.maxCount
 *   – resolveQuotaConfig: throws QuotaConfigError for unsafe platformRow.maxCount
 *   – checkAndIncrementQuota: propagates QuotaConfigError (does not silently treat as unlimited)
 *
 * Before this change: malformed limits were passed straight into arithmetic,
 * silently producing NaN/Infinity remaining counts or incorrect allow/deny decisions.
 * After this change: a QuotaConfigError is thrown so callers can surface a 500 instead
 * of issuing an incorrect 200 or 429.
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
  const dbInsert = vi.fn(() => makeInsertChain([]));

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
  validateQuotaLimit,
  QuotaConfigError,
  resolveQuotaConfig,
  checkAndIncrementQuota,
  type QuotaResource,
} from "@/lib/quota";

// ── Fake DB ───────────────────────────────────────────────────────────────────

const fakeDb = {
  select: mocks.dbSelect,
  insert: mocks.dbInsert,
} as unknown as Parameters<typeof checkAndIncrementQuota>[0];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    talosId: "agent-1",
    resource: "activity_writes" as QuotaResource,
    maxCount: 100,
    windowSize: "daily",
    enabled: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
  mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));
});

// ─── validateQuotaLimit ───────────────────────────────────────────────────────

describe("validateQuotaLimit", () => {
  it("accepts safe positive integers", () => {
    expect(validateQuotaLimit(1)).toBe(true);
    expect(validateQuotaLimit(100)).toBe(true);
    expect(validateQuotaLimit(10_000)).toBe(true);
    expect(validateQuotaLimit(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects zero", () => {
    expect(validateQuotaLimit(0)).toBe(false);
  });

  it("rejects negative integers", () => {
    expect(validateQuotaLimit(-1)).toBe(false);
    expect(validateQuotaLimit(-100)).toBe(false);
  });

  it("rejects values above Number.MAX_SAFE_INTEGER", () => {
    expect(validateQuotaLimit(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(validateQuotaLimit(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(validateQuotaLimit(Infinity)).toBe(false);
    expect(validateQuotaLimit(-Infinity)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(validateQuotaLimit(NaN)).toBe(false);
  });

  it("rejects floats", () => {
    expect(validateQuotaLimit(1.5)).toBe(false);
    expect(validateQuotaLimit(99.9)).toBe(false);
  });

  it("rejects non-number types", () => {
    expect(validateQuotaLimit("100")).toBe(false);
    expect(validateQuotaLimit(null)).toBe(false);
    expect(validateQuotaLimit(undefined)).toBe(false);
    expect(validateQuotaLimit([])).toBe(false);
    expect(validateQuotaLimit({})).toBe(false);
  });
});

// ─── resolveQuotaConfig ───────────────────────────────────────────────────────

describe("resolveQuotaConfig — unsafe limits", () => {
  const UNSAFE_VALUES = [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const badLimit of UNSAFE_VALUES) {
    it(`throws QuotaConfigError when agentRow.maxCount = ${badLimit}`, async () => {
      const agentRow = makeRow({ talosId: "agent-1", maxCount: badLimit });
      mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

      await expect(
        resolveQuotaConfig(fakeDb, "agent-1", "activity_writes"),
      ).rejects.toThrow(QuotaConfigError);
    });
  }

  it("QuotaConfigError message names the agent and resource", async () => {
    const agentRow = makeRow({ talosId: "agent-x", maxCount: -99 });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

    await expect(
      resolveQuotaConfig(fakeDb, "agent-x", "job_writes"),
    ).rejects.toThrow(/agent-x.*job_writes/);
  });

  it("throws QuotaConfigError when platformRow.maxCount is unsafe", async () => {
    const platformRow = makeRow({ talosId: null, maxCount: 0 });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([platformRow]));

    await expect(
      resolveQuotaConfig(fakeDb, "agent-1", "activity_writes"),
    ).rejects.toThrow(QuotaConfigError);
  });

  it("QuotaConfigError.type discriminant is 'QuotaConfigError'", async () => {
    const agentRow = makeRow({ maxCount: NaN });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

    const err = await resolveQuotaConfig(fakeDb, "agent-1", "activity_writes").catch((e) => e);
    expect(err).toBeInstanceOf(QuotaConfigError);
    expect(err.type).toBe("QuotaConfigError");
  });

  it("does NOT throw for safe limit at boundary (Number.MAX_SAFE_INTEGER)", async () => {
    const agentRow = makeRow({ maxCount: Number.MAX_SAFE_INTEGER });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

    const config = await resolveQuotaConfig(fakeDb, "agent-1", "activity_writes");
    expect(config.maxCount).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ─── checkAndIncrementQuota ───────────────────────────────────────────────────

describe("checkAndIncrementQuota — propagates QuotaConfigError", () => {
  it("propagates QuotaConfigError instead of returning unlimited ok:true", async () => {
    // DB returns a row with an unsafe limit
    const agentRow = makeRow({ maxCount: Infinity });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

    await expect(
      checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes"),
    ).rejects.toThrow(QuotaConfigError);

    // The upsert must NOT have been reached
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("propagates QuotaConfigError for a negative limit", async () => {
    const agentRow = makeRow({ maxCount: -1 });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow]));

    await expect(
      checkAndIncrementQuota(fakeDb, "agent-1", "revenue_writes"),
    ).rejects.toThrow(QuotaConfigError);
  });
});
