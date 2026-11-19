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

import { checkOwnership } from "../src/lib/jobs/ownership";

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

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    queue: "test_queue",
    payload: {},
    status: "leased",
    priority: 0,
    runAt: new Date(),
    leaseId: "lease_1",
    leaseOwner: "worker_1",
    leaseExpiresAt: new Date(Date.now() + 30_000),
    heartbeatAt: new Date(),
    attempts: 1,
    maxAttempts: 8,
    retryClass: "transient",
    cancelRequested: false,
    idempotencyKey: null,
    lastError: null,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobs/ownership — checkOwnership", () => {
  it("returns empty arrays when no inconsistencies exist", async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toEqual([]);
    expect(report.orphanedAttempts).toEqual([]);
    expect(report.checkedAt).toBeInstanceOf(Date);
  });

  it("detects a leased job with null leaseId as incompatible", async () => {
    const row = makeRow({ leaseId: null });
    mockDb.select
      .mockReturnValueOnce(chainable([row]))
      .mockReturnValueOnce(chainable([]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toHaveLength(1);
    expect(report.incompatibleLeases[0].id).toBe("job_1");
    expect(report.orphanedAttempts).toHaveLength(0);
  });

  it("detects a leased job with null leaseOwner as incompatible", async () => {
    const row = makeRow({ leaseOwner: null });
    mockDb.select
      .mockReturnValueOnce(chainable([row]))
      .mockReturnValueOnce(chainable([]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toHaveLength(1);
    expect(report.incompatibleLeases[0].leaseOwner).toBeNull();
  });

  it("detects a leased job with null leaseExpiresAt in both incompatible and orphaned lists", async () => {
    const row = makeRow({ leaseExpiresAt: null });
    mockDb.select
      .mockReturnValueOnce(chainable([row]))
      .mockReturnValueOnce(chainable([row]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toHaveLength(1);
    expect(report.orphanedAttempts).toHaveLength(1);
    expect(report.incompatibleLeases[0].leaseExpiresAt).toBeNull();
  });

  it("detects a job where attempts exceed maxAttempts as orphaned", async () => {
    const row = makeRow({ attempts: 10, maxAttempts: 8, leaseExpiresAt: new Date(Date.now() + 30_000) });
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([row]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toHaveLength(0);
    expect(report.orphanedAttempts).toHaveLength(1);
    expect(report.orphanedAttempts[0].attempts).toBe(10);
  });

  it("checkedAt is a recent Date", async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    const before = Date.now();
    const report = await checkOwnership();
    const after = Date.now();

    expect(report.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(report.checkedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("report is read-only — no db.update or db.insert calls are made", async () => {
    mockDb.select
      .mockReturnValueOnce(chainable([]))
      .mockReturnValueOnce(chainable([]));

    await checkOwnership();

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("surfaces multiple incompatible leases in a single report", async () => {
    const rows = [
      makeRow({ id: "job_1", leaseId: null }),
      makeRow({ id: "job_2", leaseOwner: null }),
    ];
    mockDb.select
      .mockReturnValueOnce(chainable(rows))
      .mockReturnValueOnce(chainable([]));

    const report = await checkOwnership();

    expect(report.incompatibleLeases).toHaveLength(2);
    expect(report.incompatibleLeases.map((j) => j.id)).toEqual(["job_1", "job_2"]);
  });
});
