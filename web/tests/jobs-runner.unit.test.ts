import { vi, describe, it, expect, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {
    reapExpiredLeases: vi.fn(),
    leaseBatch: vi.fn(),
    heartbeat: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock("../src/lib/jobs/store", () => mocks.store);

import { runOnce } from "../src/lib/jobs/runner";
import { registerHandler, __resetRegistryForTests } from "../src/lib/jobs/registry";
import type { JobRecord } from "../src/lib/jobs/types";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
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
  __resetRegistryForTests();
  mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 0, deadLettered: 0 });
});

describe("jobs/runner — runOnce", () => {
  it("reaps expired leases and returns early when no queues are registered", async () => {
    mocks.store.reapExpiredLeases.mockResolvedValue({ requeued: 2, deadLettered: 1 });

    const summary = await runOnce();

    expect(summary).toEqual({ leased: 0, completed: 0, retried: 0, deadLettered: 0, cancelled: 0, reaped: 3 });
    expect(mocks.store.leaseBatch).not.toHaveBeenCalled();
  });

  it("runs the registered handler and completes the job on success", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob()]);
    mocks.store.complete.mockResolvedValue(makeJob({ status: "completed" }));

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mocks.store.complete).toHaveBeenCalledWith("job_1", "lease_1", { ok: true }, expect.any(Number));
    expect(summary.leased).toBe(1);
    expect(summary.completed).toBe(1);
  });

  it("passes payload/attempts through to the handler's context", async () => {
    const handler = vi.fn().mockResolvedValue({});
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob({ payload: { foo: "bar" }, attempts: 3, maxAttempts: 5 })]);
    mocks.store.complete.mockResolvedValue(makeJob());

    await runOnce({ heartbeatIntervalMs: 60_000 });

    const ctx = handler.mock.calls[0][0];
    expect(ctx.payload).toEqual({ foo: "bar" });
    expect(ctx.attempts).toBe(3);
    expect(ctx.maxAttempts).toBe(5);
    expect(typeof ctx.heartbeat).toBe("function");
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it("dead-letters jobs on a queue with no registered handler, without calling any handler", async () => {
    mocks.store.leaseBatch.mockResolvedValue([makeJob({ queue: "unregistered" })]);
    mocks.store.fail.mockResolvedValue(makeJob({ status: "dead_letter" }));

    const summary = await runOnce({ queues: ["unregistered"] });

    expect(mocks.store.fail).toHaveBeenCalledWith("job_1", "lease_1", expect.any(Error));
    expect(summary.deadLettered).toBe(1);
  });

  it("calls store.fail on handler failure and counts a retry (status back to pending)", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("upstream 500"));
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob()]);
    mocks.store.fail.mockResolvedValue(makeJob({ status: "pending" }));

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(mocks.store.fail).toHaveBeenCalledWith("job_1", "lease_1", expect.any(Error), expect.any(Number));
    expect(summary.retried).toBe(1);
    expect(summary.deadLettered).toBe(0);
  });

  it("counts a dead-lettered job when store.fail exhausts retries", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("fatal"));
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob()]);
    mocks.store.fail.mockResolvedValue(makeJob({ status: "dead_letter" }));

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(summary.deadLettered).toBe(1);
    expect(summary.retried).toBe(0);
  });

  it("does not call complete()/fail() when the lease was lost mid-run", async () => {
    const handler = vi.fn().mockImplementation(async (ctx) => {
      await ctx.heartbeat();
      return { ok: true };
    });
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob()]);
    mocks.store.heartbeat.mockResolvedValue({ ok: false, cancelled: false });

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(mocks.store.complete).not.toHaveBeenCalled();
    expect(mocks.store.fail).not.toHaveBeenCalled();
    expect(summary.completed).toBe(0);
  });

  it("counts a job cancelled mid-run and does not complete/fail it", async () => {
    const handler = vi.fn().mockImplementation(async (ctx) => {
      await ctx.heartbeat();
      return { ok: true };
    });
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([makeJob()]);
    mocks.store.heartbeat.mockResolvedValue({ ok: true, cancelled: true });

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(mocks.store.complete).not.toHaveBeenCalled();
    expect(mocks.store.fail).not.toHaveBeenCalled();
    expect(summary.cancelled).toBe(1);
  });

  it("calls onLeased with the claimed batch before running handlers", async () => {
    const handler = vi.fn().mockResolvedValue({});
    registerHandler("test_queue", handler);
    const batch = [makeJob()];
    mocks.store.leaseBatch.mockResolvedValue(batch);
    mocks.store.complete.mockResolvedValue(makeJob({ status: "completed" }));

    const onLeased = vi.fn();
    await runOnce({ heartbeatIntervalMs: 60_000, onLeased });

    expect(onLeased).toHaveBeenCalledWith(batch);
    expect(onLeased.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[0]);
  });

  it("processes a full batch concurrently", async () => {
    const handler = vi.fn().mockResolvedValue({});
    registerHandler("test_queue", handler);
    mocks.store.leaseBatch.mockResolvedValue([
      makeJob({ id: "job_1", leaseId: "lease_1" }),
      makeJob({ id: "job_2", leaseId: "lease_2" }),
      makeJob({ id: "job_3", leaseId: "lease_3" }),
    ]);
    mocks.store.complete.mockResolvedValue(makeJob({ status: "completed" }));

    const summary = await runOnce({ heartbeatIntervalMs: 60_000 });

    expect(handler).toHaveBeenCalledTimes(3);
    expect(summary.leased).toBe(3);
    expect(summary.completed).toBe(3);
  });
});
