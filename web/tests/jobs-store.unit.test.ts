import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));
const { mockDb } = mocks;

vi.mock("@/db", () => ({ db: mocks.mockDb }));

import * as store from "../src/lib/jobs/store";
import { jobsConfig } from "../src/lib/jobs/config";
import { boundError, boundResult, truncateError, truncateResult } from "../src/lib/jobs/metrics";

/**
 * A single object whose chained methods (from/where/orderBy/limit/set/values)
 * all return itself, and which is both awaitable directly (drizzle query
 * builders are thenables) and exposes `.returning()` — covering every shape
 * store.ts calls against `db.select()/.insert()/.update()`.
 */
function chainable<T>(result: T) {
  const obj: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "set", "values"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.returning = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobs/store — enqueue", () => {
  it("inserts a new job when no idempotencyKey is given", async () => {
    const inserted = { id: "job_1", queue: "q", payload: {}, status: "pending" };
    mockDb.insert.mockReturnValue({ values: vi.fn(() => chainable([inserted])) });

    const job = await store.enqueue("q", { a: 1 });

    expect(job.id).toBe("job_1");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns the existing row instead of inserting when idempotencyKey already exists", async () => {
    const existing = { id: "job_existing", queue: "q", idempotencyKey: "k1" };
    mockDb.select.mockReturnValue(chainable([existing]));

    const job = await store.enqueue("q", { a: 1 }, { idempotencyKey: "k1" });

    expect(job.id).toBe("job_existing");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("inserts when idempotencyKey is new", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    const inserted = { id: "job_new", queue: "q", idempotencyKey: "k2" };
    mockDb.insert.mockReturnValue({ values: vi.fn(() => chainable([inserted])) });

    const job = await store.enqueue("q", {}, { idempotencyKey: "k2" });

    expect(job.id).toBe("job_new");
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });
});

describe("jobs/store — leaseBatch", () => {
  it("returns [] without querying when no queues are given", async () => {
    const rows = await store.leaseBatch([], 10, "worker-1");
    expect(rows).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("claims rows via db.execute and maps them to JobRecords", async () => {
    const row = { id: "job_1", queue: "q", leaseId: "lease-1", status: "leased", attempts: 1 };
    mockDb.execute.mockResolvedValue({ rows: [row] });

    const rows = await store.leaseBatch(["q"], 5, "worker-1", 30_000);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("job_1");
    expect(rows[0].leaseId).toBe("lease-1");
  });
});

describe("jobs/store — heartbeat", () => {
  it("returns ok:true and the row's cancelRequested flag when the lease is still held", async () => {
    mockDb.update.mockReturnValue(chainable([{ cancelRequested: false, queue: "q" }]));
    const result = await store.heartbeat("job_1", "lease_1");
    expect(result).toEqual({ ok: true, cancelled: false });
  });

  it("reports cancellation via the row's cancelRequested flag", async () => {
    mockDb.update.mockReturnValue(chainable([{ cancelRequested: true, queue: "q" }]));
    const result = await store.heartbeat("job_1", "lease_1");
    expect(result).toEqual({ ok: true, cancelled: true });
  });

  it("returns ok:false when the lease was lost (0 rows updated)", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    const result = await store.heartbeat("job_1", "stale_lease");
    expect(result).toEqual({ ok: false, cancelled: false });
  });

  it("checks both lease identifier and lease expiry (leaseExpiresAt > now()) in where clause", async () => {
    const chain = chainable([{ cancelRequested: false, queue: "q" }]);
    mockDb.update.mockReturnValue(chain);

    await store.heartbeat("job_1", "lease_1");

    expect(chain.where).toHaveBeenCalledTimes(1);
    const whereCondition = chain.where.mock.calls[0][0];
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();
    const compiled = dialect.sqlToQuery(whereCondition.getSQL());
    expect(compiled.sql).toContain('"tls_jobs"."leaseExpiresAt" > now()');
    expect(compiled.sql).toContain('"tls_jobs"."leaseId" = $');
    expect(compiled.sql).toContain('"tls_jobs"."status" = $');
    expect(compiled.params).toContain("job_1");
    expect(compiled.params).toContain("lease_1");
    expect(compiled.params).toContain("leased");
  });

  it("rejects heartbeat requests after lease deadline has elapsed (0 rows updated)", async () => {
    // When the lease has expired, the WHERE clause (leaseExpiresAt > now()) matches no rows.
    mockDb.update.mockReturnValue(chainable([]));
    const result = await store.heartbeat("job_1", "expired_lease");
    expect(result).toEqual({ ok: false, cancelled: false });
  });

  it("leaves expired lease eligible for reapExpiredLeases after heartbeat is rejected", async () => {
    // 1. Worker attempts heartbeat on expired lease -> rejected without modifying db state
    mockDb.update.mockReturnValueOnce(chainable([]));
    const heartbeatResult = await store.heartbeat("job_expired", "lease_expired");
    expect(heartbeatResult.ok).toBe(false);

    // 2. Normal reaper runs and recovers the unmutated expired lease
    const reapedRow = { id: "job_expired", queue: "q" };
    mockDb.update
      .mockReturnValueOnce(chainable([reapedRow])) // requeued
      .mockReturnValueOnce(chainable([])); // deadLettered

    const reapSummary = await store.reapExpiredLeases();
    expect(reapSummary).toEqual({ requeued: 1, deadLettered: 0 });
  });
});

describe("jobs/store — complete", () => {
  it("marks the job completed and returns the row", async () => {
    const row = { id: "job_1", queue: "q", status: "completed", attempts: 1 };
    mockDb.update.mockReturnValue(chainable([row]));
    const result = await store.complete("job_1", "lease_1", { ok: true });
    expect(result?.status).toBe("completed");
  });

  it("returns null when the lease was already lost", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    const result = await store.complete("job_1", "stale_lease", {});
    expect(result).toBeNull();
  });

  it("persists a result whose serialized JSON size is exactly at maxResultBytes", async () => {
    const originalMax = jobsConfig.maxResultBytes;
    try {
      const payload = { ok: true, data: "a".repeat(64) };
      const exactBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      jobsConfig.maxResultBytes = exactBytes;

      let capturedSet: Record<string, unknown> | undefined;
      mockDb.update.mockImplementation(() => {
        const obj = chainable([{ id: "job_1", queue: "q", status: "completed", attempts: 1, result: payload }]);
        const originalSet = obj.set as (v: unknown) => unknown;
        obj.set = vi.fn((v: Record<string, unknown>) => {
          capturedSet = v;
          return originalSet(v);
        });
        return obj;
      });

      await store.complete("job_1", "lease_1", payload);
      expect(capturedSet?.result).toEqual(payload);
    } finally {
      jobsConfig.maxResultBytes = originalMax;
    }
  });

  it("replaces an oversized result with a stable bounded diagnostic envelope", async () => {
    const originalMax = jobsConfig.maxResultBytes;
    const originalErrMax = jobsConfig.maxErrorBytes;
    try {
      jobsConfig.maxResultBytes = 128;
      jobsConfig.maxErrorBytes = 500; // error bound is higher and independent
      const oversized = { blob: "x".repeat(300) };
      const expectedActualBytes = Buffer.byteLength(JSON.stringify(oversized), "utf8");

      let capturedSet: Record<string, unknown> | undefined;
      mockDb.update.mockImplementation(() => {
        const obj = chainable([{ id: "job_1", queue: "q", status: "completed", attempts: 1 }]);
        const originalSet = obj.set as (v: unknown) => unknown;
        obj.set = vi.fn((v: Record<string, unknown>) => {
          capturedSet = v;
          return originalSet(v);
        });
        return obj;
      });

      await store.complete("job_1", "lease_1", oversized);

      expect(capturedSet?.result).toEqual({
        truncated: true,
        reason: "result_exceeds_max_bytes",
        maxBytes: 128,
        actualBytes: expectedActualBytes,
        diagnostic: `job result size (${expectedActualBytes} bytes) exceeded maxResultBytes (128 bytes)`,
      });
    } finally {
      jobsConfig.maxResultBytes = originalMax;
      jobsConfig.maxErrorBytes = originalErrMax;
    }
  });

  it("replaces an unserializable result (circular / BigInt) with a stable diagnostic envelope without throwing", async () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;

    let capturedSet: Record<string, unknown> | undefined;
    mockDb.update.mockImplementation(() => {
      const obj = chainable([{ id: "job_1", queue: "q", status: "completed", attempts: 1 }]);
      const originalSet = obj.set as (v: unknown) => unknown;
      obj.set = vi.fn((v: Record<string, unknown>) => {
        capturedSet = v;
        return originalSet(v);
      });
      return obj;
    });

    await store.complete("job_1", "lease_1", circular);

    expect(capturedSet?.result).toEqual({
      truncated: true,
      reason: "result_unserializable",
      maxBytes: jobsConfig.maxResultBytes,
      actualBytes: null,
      diagnostic: "job result could not be serialized to JSON",
    });
  });
});

describe("jobs/store — fail", () => {
  it("reschedules (pending) a transient failure below maxAttempts", async () => {
    const current = { id: "job_1", leaseId: "lease_1", status: "leased", attempts: 1, maxAttempts: 8, retryClass: "transient" };
    const updated = { id: "job_1", queue: "q", status: "pending", attempts: 1 };
    mockDb.select.mockReturnValue(chainable([current]));
    mockDb.update.mockReturnValue(chainable([updated]));

    const result = await store.fail("job_1", "lease_1", new Error("boom"));

    expect(result?.status).toBe("pending");
  });

  it("dead-letters once attempts reach maxAttempts", async () => {
    const current = { id: "job_1", leaseId: "lease_1", status: "leased", attempts: 8, maxAttempts: 8, retryClass: "transient" };
    const updated = { id: "job_1", queue: "q", status: "dead_letter", attempts: 8, maxAttempts: 8 };
    mockDb.select.mockReturnValue(chainable([current]));
    mockDb.update.mockReturnValue(chainable([updated]));

    const result = await store.fail("job_1", "lease_1", new Error("boom"));

    expect(result?.status).toBe("dead_letter");
  });

  it("dead-letters fatal errors on the first attempt", async () => {
    const current = { id: "job_1", leaseId: "lease_1", status: "leased", attempts: 1, maxAttempts: 8, retryClass: "fatal" };
    const updated = { id: "job_1", queue: "q", status: "dead_letter", attempts: 1, maxAttempts: 8 };
    mockDb.select.mockReturnValue(chainable([current]));
    mockDb.update.mockReturnValue(chainable([updated]));

    const result = await store.fail("job_1", "lease_1", new Error("bad input"));

    expect(result?.status).toBe("dead_letter");
  });

  it("returns null when the lease was already lost", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    const result = await store.fail("job_1", "stale_lease", new Error("boom"));
    expect(result).toBeNull();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("never leaks the raw error object into lastError — only a truncated message", async () => {
    const current = { id: "job_1", leaseId: "lease_1", status: "leased", attempts: 1, maxAttempts: 8, retryClass: "transient" };
    mockDb.select.mockReturnValue(chainable([current]));
    let capturedSet: Record<string, unknown> | undefined;
    mockDb.update.mockImplementation(() => {
      const obj = chainable([{ id: "job_1", queue: "q", status: "pending" }]);
      const originalSet = obj.set as (v: unknown) => unknown;
      obj.set = vi.fn((v: Record<string, unknown>) => {
        capturedSet = v;
        return originalSet(v);
      });
      return obj;
    });

    await store.fail("job_1", "lease_1", new Error("secret-token=abc123 leaked in message"));

    expect(typeof capturedSet?.lastError).toBe("string");
    expect(capturedSet?.lastError).toContain("secret-token=abc123");
    expect(capturedSet?.leaseId).toBeNull();
  });

  it("bounds oversized lastError independently of maxResultBytes on both retry and dead_letter transitions", async () => {
    const originalErrMax = jobsConfig.maxErrorBytes;
    const originalResMax = jobsConfig.maxResultBytes;
    try {
      jobsConfig.maxErrorBytes = 32;
      jobsConfig.maxResultBytes = 65_536; // result limit stays large while error limit is tight

      const current = { id: "job_1", queue: "q", leaseId: "lease_1", status: "leased", attempts: 8, maxAttempts: 8, retryClass: "transient" };
      mockDb.select.mockReturnValue(chainable([current]));
      let capturedSet: Record<string, unknown> | undefined;
      mockDb.update.mockImplementation(() => {
        const obj = chainable([{ id: "job_1", queue: "q", status: "dead_letter", attempts: 8, maxAttempts: 8 }]);
        const originalSet = obj.set as (v: unknown) => unknown;
        obj.set = vi.fn((v: Record<string, unknown>) => {
          capturedSet = v;
          return originalSet(v);
        });
        return obj;
      });

      const longMsg = "E".repeat(120);
      await store.fail("job_1", "lease_1", new Error(longMsg));

      expect(capturedSet?.status).toBe("dead_letter");
      expect(capturedSet?.lastError).toBe(`${"E".repeat(32)}…`);
    } finally {
      jobsConfig.maxErrorBytes = originalErrMax;
      jobsConfig.maxResultBytes = originalResMax;
    }
  });
});

describe("jobs/metrics — independent result and error bounding", () => {
  it("bounds error messages by UTF-8 byte length without splitting multi-byte code points", () => {
    // "🚀" is 4 UTF-8 bytes; with maxBytes=10, at most two rockets (8 bytes) fit before "…"
    const multiByte = "🚀".repeat(5); // 20 bytes
    const outcome = boundError(new Error(multiByte), 10);
    expect(outcome.truncated).toBe(true);
    expect(outcome.actualBytes).toBe(20);
    expect(outcome.maxBytes).toBe(10);
    expect(outcome.value).toBe("🚀🚀…");
    // Ensure no replacement character / broken surrogate exists
    expect(Buffer.from(outcome.value, "utf8").toString("utf8")).toBe("🚀🚀…");
  });

  it("keeps error messages at or below the exact UTF-8 byte boundary untouched", () => {
    const exact = "a".repeat(64);
    const outcome = boundError(new Error(exact), 64);
    expect(outcome).toEqual({
      value: exact,
      truncated: false,
      actualBytes: 64,
      maxBytes: 64,
    });
    expect(truncateError(new Error(exact), 64)).toBe(exact);
  });

  it("bounds result and error sizes with independent thresholds", () => {
    const smallResultLimit = 60;
    const largeErrorLimit = 200;

    const payload = { detail: "x".repeat(80) }; // > 60 bytes
    const errText = "e".repeat(120); // <= 200 bytes

    const resOutcome = boundResult(payload, smallResultLimit);
    const errOutcome = boundError(new Error(errText), largeErrorLimit);

    expect(resOutcome.truncated).toBe(true);
    expect(resOutcome.reason).toBe("result_exceeds_max_bytes");
    expect(errOutcome.truncated).toBe(false);
    expect(errOutcome.value).toBe(errText);

    // Reverse: large result limit, small error limit
    const resOutcome2 = boundResult(payload, 500);
    const errOutcome2 = boundError(new Error(errText), 40);

    expect(resOutcome2.truncated).toBe(false);
    expect(resOutcome2.value).toEqual(payload);
    expect(errOutcome2.truncated).toBe(true);
    expect(errOutcome2.value).toBe(`${"e".repeat(40)}…`);
    expect(truncateResult(payload, 500)).toEqual(payload);
  });
});

describe("jobs/store — release", () => {
  it("returns the job to pending and clears lease fields", async () => {
    const row = { id: "job_1", queue: "q", status: "pending", leaseId: null };
    mockDb.update.mockReturnValue(chainable([row]));
    const result = await store.release("job_1", "lease_1");
    expect(result?.status).toBe("pending");
  });

  it("is a safe no-op when the lease no longer matches (already completed elsewhere)", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    const result = await store.release("job_1", "stale_lease");
    expect(result).toBeNull();
  });
});

describe("jobs/store — requestCancel", () => {
  it("cancels a pending job immediately", async () => {
    const row = { id: "job_1", queue: "q", status: "cancelled" };
    mockDb.update.mockReturnValueOnce(chainable([row]));
    const result = await store.requestCancel("job_1");
    expect(result?.status).toBe("cancelled");
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("falls back to flagging a leased job for cooperative cancellation", async () => {
    mockDb.update
      .mockReturnValueOnce(chainable([])) // not pending
      .mockReturnValueOnce(chainable([{ id: "job_1", queue: "q", status: "leased", cancelRequested: true }]));
    const result = await store.requestCancel("job_1");
    expect(result?.status).toBe("leased");
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });

  it("returns null when the job is in a terminal state", async () => {
    mockDb.update.mockReturnValueOnce(chainable([])).mockReturnValueOnce(chainable([]));
    const result = await store.requestCancel("job_1");
    expect(result).toBeNull();
  });
});

describe("jobs/store — requeue", () => {
  it("resets a dead_letter job back to pending", async () => {
    mockDb.update.mockReturnValue(chainable([{ id: "job_1", status: "pending", attempts: 0 }]));
    const result = await store.requeue("job_1");
    expect(result?.status).toBe("pending");
    expect(result?.attempts).toBe(0);
  });

  it("returns null for a job that isn't dead_letter/cancelled", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    const result = await store.requeue("job_1");
    expect(result).toBeNull();
  });
});

describe("jobs/store — reapExpiredLeases", () => {
  it("counts requeued and dead-lettered rows", async () => {
    mockDb.update
      .mockReturnValueOnce(chainable([{ id: "a", queue: "q" }, { id: "b", queue: "q" }]))
      .mockReturnValueOnce(chainable([{ id: "c", queue: "q" }]));

    const result = await store.reapExpiredLeases();

    expect(result).toEqual({ requeued: 2, deadLettered: 1 });
  });
});

describe("jobs/store — listJobs / getJob", () => {
  it("requests one extra row to compute nextCursor", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `job_${i}`,
      createdAt: new Date(Date.now() - i * 1000),
    }));
    mockDb.select.mockReturnValue(chainable(rows));

    const { jobs, nextCursor } = await store.listJobs({ limit: 50 });

    expect(jobs).toHaveLength(50);
    expect(nextCursor).toBe(rows[49].createdAt.toISOString());
  });

  it("returns null nextCursor when there is no next page", async () => {
    mockDb.select.mockReturnValue(chainable([{ id: "job_1", createdAt: new Date() }]));
    const { nextCursor } = await store.listJobs({ limit: 50 });
    expect(nextCursor).toBeNull();
  });

  it("getJob returns null for a missing id", async () => {
    mockDb.select.mockReturnValue(chainable([]));
    expect(await store.getJob("missing")).toBeNull();
  });
});
