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
