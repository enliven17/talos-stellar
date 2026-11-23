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

import { expireAgedPendingJobs } from "../src/lib/jobs/store";

/**
 * chainable mirrors the pattern in jobs-store.unit.test.ts: a fluent builder
 * whose chained methods all return itself, is directly awaitable, and exposes
 * .returning() covering every shape store.ts calls against db.update().
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

describe("jobs/store — expireAgedPendingJobs", () => {
  it("returns 0 without querying when queueAgeDeadlineMs is 0 (disabled)", async () => {
    const count = await expireAgedPendingJobs(0);
    expect(count).toBe(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("returns 0 without querying when queueAgeDeadlineMs is negative", async () => {
    const count = await expireAgedPendingJobs(-1);
    expect(count).toBe(0);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("returns 0 when no pending jobs match the age cutoff", async () => {
    mockDb.update.mockReturnValue(chainable([]));
    const count = await expireAgedPendingJobs(60_000);
    expect(count).toBe(0);
  });

  it("expires pending jobs older than the deadline and returns the count", async () => {
    const rows = [
      { id: "job_1", queue: "q" },
      { id: "job_2", queue: "q" },
    ];
    mockDb.update.mockReturnValue(chainable(rows));

    const count = await expireAgedPendingJobs(60_000);

    expect(count).toBe(2);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it("sets status to dead_letter on expired jobs", async () => {
    let capturedSet: Record<string, unknown> | undefined;
    const c = chainable([{ id: "job_1", queue: "q" }]);
    const originalSet = c.set as (v: unknown) => unknown;
    c.set = vi.fn((v: Record<string, unknown>) => {
      capturedSet = v;
      return originalSet(v);
    });
    mockDb.update.mockReturnValue(c);

    await expireAgedPendingJobs(60_000);

    expect(capturedSet?.status).toBe("dead_letter");
  });

  it("includes the configured deadline in the lastError message", async () => {
    let capturedSet: Record<string, unknown> | undefined;
    const c = chainable([{ id: "job_1", queue: "q" }]);
    const originalSet = c.set as (v: unknown) => unknown;
    c.set = vi.fn((v: Record<string, unknown>) => {
      capturedSet = v;
      return originalSet(v);
    });
    mockDb.update.mockReturnValue(c);

    await expireAgedPendingJobs(90_000);

    expect(typeof capturedSet?.lastError).toBe("string");
    expect(capturedSet?.lastError).toContain("90000");
  });

  it("does not modify attempts — the job never ran", async () => {
    let capturedSet: Record<string, unknown> | undefined;
    const c = chainable([{ id: "job_1", queue: "q" }]);
    const originalSet = c.set as (v: unknown) => unknown;
    c.set = vi.fn((v: Record<string, unknown>) => {
      capturedSet = v;
      return originalSet(v);
    });
    mockDb.update.mockReturnValue(c);

    await expireAgedPendingJobs(60_000);

    // The set payload must not include an attempts field — the ceiling is preserved
    expect(capturedSet).not.toHaveProperty("attempts");
  });
});
