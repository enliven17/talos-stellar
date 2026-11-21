/**
 * Completed-idempotency-key expiry and bounded-cleanup tests.
 *
 * Test matrix:
 *   positive   — an expired completed key is selected and deleted
 *   positive   — expiry is derived from the terminal timestamp plus retention
 *   negative   — in-flight (pending / negotiating / counter_offer) rows are never eligible
 *   negative   — keyless rows are never eligible
 *   negative   — missing/malformed expiry fails closed (row is never deleted)
 *   boundary   — a key exactly at its expiry instant is expired (inclusive)
 *   boundary   — a key one millisecond inside retention is not expired
 *   bounded    — a run never deletes more than `limit`, and reports hasMore
 *   regression — re-running after the expired rows are gone deletes nothing
 *   failure    — missing table/column and dependency failures return a structured code
 *   input      — malformed limits/clock are clamped or rejected, never unbounded
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));

import {
  COMPLETED_JOB_STATUS,
  IDEMPOTENCY_CLEANUP_MAX_BATCH,
  cleanupExpiredIdempotencyKeys,
  computeIdempotencyExpiry,
  idempotencyConfig,
  isExpiredCompletedIdempotencyKey,
  resolveCleanupBatchSize,
  resolveIdempotencyExpiresAt,
  selectExpiredIdempotencyIds,
  type ExpiringIdempotencyRecord,
} from "../src/lib/idempotency";

const { mockDb } = mocks;

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
const NOW = new Date("2026-09-28T12:00:00.000Z");

/** Thenable stand-in for a drizzle select chain: .from().where().orderBy().limit(). */
function selectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

/** Thenable stand-in for a drizzle delete chain: .where().returning(). */
function deleteChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["where", "returning"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (onFulfilled: (v: unknown[]) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function record(overrides: Partial<ExpiringIdempotencyRecord> = {}): ExpiringIdempotencyRecord {
  return {
    id: "job-1",
    status: COMPLETED_JOB_STATUS,
    idempotencyKey: "key-1",
    // Completed well before the retention window closes, for NOW.
    updatedAt: new Date(NOW.getTime() - RETENTION_MS - 1_000),
    createdAt: new Date(NOW.getTime() - RETENTION_MS - 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("idempotency/expiry — derived expiry", () => {
  it("derives expiry as terminal timestamp + retention", () => {
    const expiresAt = resolveIdempotencyExpiresAt(record(), RETENTION_MS);
    expect(expiresAt?.getTime()).toBe(record().updatedAt!.getTime() + RETENTION_MS);
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    const createdAt = new Date(NOW.getTime() - RETENTION_MS);
    const expiresAt = resolveIdempotencyExpiresAt(record({ updatedAt: null, createdAt }), RETENTION_MS);
    expect(expiresAt?.getTime()).toBe(createdAt.getTime() + RETENTION_MS);
  });

  it("computeIdempotencyExpiry adds the retention window", () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    expect(computeIdempotencyExpiry(base, RETENTION_MS)?.getTime()).toBe(base.getTime() + RETENTION_MS);
  });

  it("returns null for an absent completion timestamp (fail closed)", () => {
    expect(computeIdempotencyExpiry(null)).toBeNull();
    expect(computeIdempotencyExpiry(undefined)).toBeNull();
    expect(resolveIdempotencyExpiresAt({ updatedAt: null, createdAt: null }, RETENTION_MS)).toBeNull();
  });

  it("returns null for a malformed completion timestamp (fail closed)", () => {
    expect(computeIdempotencyExpiry(new Date("not-a-date"), RETENTION_MS)).toBeNull();
    expect(
      resolveIdempotencyExpiresAt(
        { updatedAt: "2026-01-01" as unknown as Date, createdAt: null },
        RETENTION_MS,
      ),
    ).toBeNull();
  });
});

describe("idempotency/expiry — eligibility", () => {
  it("treats a completed, keyed row past retention as expired", () => {
    expect(isExpiredCompletedIdempotencyKey(record(), NOW, RETENTION_MS)).toBe(true);
  });

  it("never expires non-completed rows, regardless of age", () => {
    for (const status of ["pending", "negotiating", "counter_offer", "failed"]) {
      const row = record({ status, updatedAt: new Date(NOW.getTime() - 365 * DAY_MS) });
      expect(isExpiredCompletedIdempotencyKey(row, NOW, RETENTION_MS)).toBe(false);
    }
  });

  it("never expires a completed row without a key", () => {
    const row = record({ idempotencyKey: null, updatedAt: new Date(NOW.getTime() - 365 * DAY_MS) });
    expect(isExpiredCompletedIdempotencyKey(row, NOW, RETENTION_MS)).toBe(false);
  });

  it("never expires a row with a missing or malformed timestamp", () => {
    expect(
      isExpiredCompletedIdempotencyKey(record({ updatedAt: null, createdAt: null }), NOW, RETENTION_MS),
    ).toBe(false);
    expect(
      isExpiredCompletedIdempotencyKey(record({ updatedAt: new Date("nope") }), NOW, RETENTION_MS),
    ).toBe(false);
  });

  it("treats exactly-at-expiry as expired (inclusive boundary)", () => {
    const row = record({ updatedAt: new Date(NOW.getTime() - RETENTION_MS) });
    expect(isExpiredCompletedIdempotencyKey(row, NOW, RETENTION_MS)).toBe(true);
  });

  it("keeps a key one millisecond inside retention", () => {
    const row = record({ updatedAt: new Date(NOW.getTime() - RETENTION_MS + 1) });
    expect(isExpiredCompletedIdempotencyKey(row, NOW, RETENTION_MS)).toBe(false);
  });
});

describe("idempotency/expiry — bounded selection", () => {
  it("caps the ids returned at the limit and reports hasMore", () => {
    const candidates = ["a", "b", "c"].map((id) => record({ id }));
    const selection = selectExpiredIdempotencyIds(candidates, NOW, RETENTION_MS, 2);
    expect(selection.toDelete).toEqual(["a", "b"]);
    expect(selection.hasMore).toBe(true);
    expect(selection.skipped).toBe(0);
  });

  it("skips rows that fail the in-process guard", () => {
    const candidates = [
      record({ id: "ok" }),
      record({ id: "in-flight", status: "pending" }),
      record({ id: "no-key", idempotencyKey: null }),
      record({ id: "malformed", updatedAt: new Date("bad") }),
    ];
    const selection = selectExpiredIdempotencyIds(candidates, NOW, RETENTION_MS, 10);
    expect(selection.toDelete).toEqual(["ok"]);
    expect(selection.skipped).toBe(3);
    expect(selection.hasMore).toBe(false);
  });

  it("selects nothing from an empty candidate page", () => {
    const selection = selectExpiredIdempotencyIds([], NOW, RETENTION_MS, 10);
    expect(selection.toDelete).toEqual([]);
    expect(selection.hasMore).toBe(false);
  });
});

describe("idempotency/expiry — cleanupExpiredIdempotencyKeys", () => {
  it("deletes expired completed rows and returns a structured count", async () => {
    mockDb.select.mockReturnValue(selectChain([record({ id: "job-1" }), record({ id: "job-2" })]));
    mockDb.delete.mockReturnValue(deleteChain([{ id: "job-1" }, { id: "job-2" }]));

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW, retentionMs: RETENTION_MS });

    expect(result).toEqual({
      ok: true,
      deleted: 2,
      examined: 2,
      skipped: 0,
      hasMore: false,
      limit: idempotencyConfig.cleanupBatchSize,
    });
  });

  it("respects the batch limit and flags that more rows remain", async () => {
    mockDb.select.mockReturnValue(
      selectChain([record({ id: "job-1" }), record({ id: "job-2" }), record({ id: "job-3" })]),
    );
    mockDb.delete.mockReturnValue(deleteChain([{ id: "job-1" }, { id: "job-2" }]));

    const result = await cleanupExpiredIdempotencyKeys({ limit: 2, now: NOW, retentionMs: RETENTION_MS });

    expect(result.ok).toBe(true);
    expect(result.examined).toBe(3);
    expect(result.deleted).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.limit).toBe(2);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it("is a no-op delete when nothing is expired (re-run safety)", async () => {
    mockDb.select.mockReturnValue(selectChain([]));

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW, retentionMs: RETENTION_MS });

    expect(result).toEqual({
      ok: true,
      deleted: 0,
      examined: 0,
      skipped: 0,
      hasMore: false,
      limit: idempotencyConfig.cleanupBatchSize,
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("never deletes a non-completed row even if the database filter is bypassed", async () => {
    mockDb.select.mockReturnValue(selectChain([record({ status: "pending" })]));

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW, retentionMs: RETENTION_MS });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("reports a missing table as a structured code instead of throwing", async () => {
    mockDb.select.mockImplementation(() => {
      throw Object.assign(new Error("relation \"tls_commerce_jobs\" does not exist"), { code: "42P01" });
    });

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW });

    expect(result).toEqual({
      ok: false,
      deleted: 0,
      examined: 0,
      skipped: 0,
      hasMore: false,
      limit: idempotencyConfig.cleanupBatchSize,
      code: "table_missing",
    });
  });

  it("reports a missing column as a structured code", async () => {
    mockDb.select.mockImplementation(() => {
      throw Object.assign(new Error("column does not exist"), { code: "42703" });
    });

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("column_missing");
  });

  it("reports other database failures as dependency_failure", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("connection terminated unexpectedly");
    });

    const result = await cleanupExpiredIdempotencyKeys({ now: NOW });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("dependency_failure");
    expect(result.deleted).toBe(0);
  });

  it("rejects a malformed clock without touching the database", async () => {
    const result = await cleanupExpiredIdempotencyKeys({ now: new Date("nope") });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_options");
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe("idempotency/expiry — resolveCleanupBatchSize", () => {
  it("uses the configured default when no limit is requested", () => {
    expect(resolveCleanupBatchSize()).toBe(idempotencyConfig.cleanupBatchSize);
    expect(resolveCleanupBatchSize(null)).toBe(idempotencyConfig.cleanupBatchSize);
  });

  it("falls back to the default for malformed limits", () => {
    expect(resolveCleanupBatchSize(0)).toBe(idempotencyConfig.cleanupBatchSize);
    expect(resolveCleanupBatchSize(-5)).toBe(idempotencyConfig.cleanupBatchSize);
    expect(resolveCleanupBatchSize(Number.NaN)).toBe(idempotencyConfig.cleanupBatchSize);
    expect(resolveCleanupBatchSize(Number.POSITIVE_INFINITY)).toBe(idempotencyConfig.cleanupBatchSize);
  });

  it("floors valid limits and hard-caps them under the maximum", () => {
    expect(resolveCleanupBatchSize(3.9)).toBe(3);
    expect(resolveCleanupBatchSize(250)).toBe(250);
    expect(resolveCleanupBatchSize(10 ** 9)).toBe(IDEMPOTENCY_CLEANUP_MAX_BATCH);
  });
});
