import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
  horizon: {
    pollTransaction: vi.fn(),
    fetchCurrentLedger: vi.fn(),
  },
  repair: {
    applyRepair: vi.fn(),
  },
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("../src/lib/reconciler/horizon", () => mocks.horizon);
vi.mock("../src/lib/reconciler/repair", () => mocks.repair);

import {
  startReconciler,
  stopReconciler,
  runOneTick,
  getStats,
  getActiveCount,
  getQueueCount,
  isRunning,
} from "../src/lib/reconciler/scheduler";
import type { TxRecord, ReconcilerConfig } from "../src/lib/reconciler/types";

function chainable<T>(result: T) {
  const obj: Record<string, any> = {};
  for (const method of ["from", "where", "orderBy", "limit", "set", "values"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.returning = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: T) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: `rec_${Math.random().toString(36).slice(2, 9)}`,
    txHash: "hash123",
    sourceType: "commerce_job",
    sourceId: "job123",
    finalityStatus: "PENDING",
    ledgerSubmitted: 1000,
    lastLedgerChecked: null,
    confirmedLedger: null,
    pollCount: 0,
    lastError: null,
    repairApplied: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const BASE_CONFIG: ReconcilerConfig = {
  enabled: true,
  pollIntervalMs: 1000,
  maxLedgerGap: 120,
  notFoundThreshold: 5,
  batchSize: 10,
  horizonUrl: "https://horizon-testnet.stellar.org",
  confirmationDepth: 1,
  concurrencyLimit: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  stopReconciler(); // ensure cleanup before each test
  mocks.horizon.fetchCurrentLedger.mockResolvedValue(1005);
  mocks.horizon.pollTransaction.mockResolvedValue({ outcome: "confirmed", ledger: 1005, successful: true });
  mocks.mockDb.update.mockReturnValue(chainable([{}]));
  mocks.repair.applyRepair.mockResolvedValue({ ok: true, repaired: true });
});

afterEach(() => {
  stopReconciler();
});

describe("reconciler/scheduler - Lifecycle", () => {
  it("starts and stops reconciler loop, and reports running state", () => {
    expect(isRunning()).toBe(false);
    startReconciler({ ...BASE_CONFIG, enabled: true });
    expect(isRunning()).toBe(true);
    stopReconciler();
    expect(isRunning()).toBe(false);
  });

  it("does not start reconciler if disabled in config", () => {
    startReconciler({ ...BASE_CONFIG, enabled: false });
    expect(isRunning()).toBe(false);
  });
});

describe("reconciler/scheduler - Concurrency and Queueing", () => {
  it("limits active in-flight processing and queues excess work", async () => {
    const records = [
      makeRecord({ id: "rec1", txHash: "h1" }),
      makeRecord({ id: "rec2", txHash: "h2" }),
      makeRecord({ id: "rec3", txHash: "h3" }),
      makeRecord({ id: "rec4", txHash: "h4" }),
    ];
    mocks.mockDb.select.mockReturnValue(chainable(records));

    // Make pollTransaction delay so that we can check active and queue states
    let resolveH1: (() => void) | null = null;
    let resolveH2: (() => void) | null = null;
    let resolveH3: (() => void) | null = null;
    let resolveH4: (() => void) | null = null;
    
    mocks.horizon.pollTransaction.mockImplementation((txHash: string) => {
      return new Promise((resolve) => {
        const result = { outcome: "confirmed", ledger: 1005, successful: true };
        if (txHash === "h1") {
          resolveH1 = () => resolve(result);
        } else if (txHash === "h2") {
          resolveH2 = () => resolve(result);
        } else if (txHash === "h3") {
          resolveH3 = () => resolve(result);
        } else if (txHash === "h4") {
          resolveH4 = () => resolve(result);
        } else {
          resolve(result);
        }
      });
    });

    const tickPromise = runOneTick(BASE_CONFIG);

    // Wait slightly for promises to execute up to their delay
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Concurrency limit is 2. h1 and h2 should be active. h3 and h4 should be queued.
    expect(getActiveCount()).toBe(2);
    expect(getQueueCount()).toBe(2);

    const stats = getStats();
    expect(stats.activeCount).toBe(2);
    expect(stats.queueCount).toBe(2);

    // Resolve h1
    if (resolveH1) (resolveH1 as () => void)();

    // Wait slightly to let h3 get picked up from queue
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Concurrency limit is 2. h2 and h3 are active. h4 is queued.
    expect(getActiveCount()).toBe(2);
    expect(getQueueCount()).toBe(1);

    // Resolve h2
    if (resolveH2) (resolveH2 as () => void)();

    // Wait slightly to let h4 get picked up from queue
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Concurrency limit is 2. h3 and h4 are active. None queued.
    expect(getActiveCount()).toBe(2);
    expect(getQueueCount()).toBe(0);

    // Resolve h3 and h4
    if (resolveH3) (resolveH3 as () => void)();
    if (resolveH4) (resolveH4 as () => void)();

    // Let tick finish
    const summary = await tickPromise;

    expect(getActiveCount()).toBe(0);
    expect(getQueueCount()).toBe(0);
    expect(summary.processed).toBe(4);
  });
});

describe("reconciler/scheduler - Failure Recovery", () => {
  it("does not permanently block the queue when a task fails", async () => {
    // rec1 is PENDING (calls pollTransaction and fails), rec2 is CONFIRMING (transitions immediately to CONFIRMED)
    const records = [
      makeRecord({ id: "rec1", txHash: "h1", finalityStatus: "PENDING" }),
      makeRecord({ id: "rec2", txHash: "h2", finalityStatus: "CONFIRMING", confirmedLedger: 1000, ledgerSubmitted: 1000 }),
    ];
    mocks.mockDb.select.mockReturnValue(chainable(records));

    // task 1 fails (throws unhandled rejection)
    mocks.horizon.pollTransaction.mockImplementation((txHash: string) => {
      if (txHash === "h1") {
        return Promise.reject(new Error("Network failure"));
      }
      return Promise.resolve({ outcome: "confirmed", ledger: 1005, successful: true });
    });

    const summary = await runOneTick({ ...BASE_CONFIG, concurrencyLimit: 1 });

    expect(summary.processed).toBe(2);
    expect(summary.errors).toBe(1); // rec1 unhandled error
    expect(summary.confirmed).toBe(1); // rec2 confirmed
    expect(getActiveCount()).toBe(0);
    expect(getQueueCount()).toBe(0);
  });
});

describe("reconciler/scheduler - Cancellation & Graceful Shutdown", () => {
  it("stops starting new work from the queue and cancels in-flight work when reconciler is stopped", async () => {
    const records = [
      makeRecord({ id: "rec1", txHash: "h1" }),
      makeRecord({ id: "rec2", txHash: "h2" }),
      makeRecord({ id: "rec3", txHash: "h3" }),
    ];
    mocks.mockDb.select.mockReturnValue(chainable(records));

    let h1Called = false;
    let h2Called = false;
    let h3Called = false;

    // Concurrency limit is 1. h1 starts, h2 and h3 are queued.
    mocks.horizon.pollTransaction.mockImplementation((txHash: string) => {
      return new Promise((resolve) => {
        if (txHash === "h1") {
          h1Called = true;
          // stop reconciler mid-run
          stopReconciler();
          resolve({ outcome: "confirmed", ledger: 1005, successful: true });
        } else if (txHash === "h2") {
          h2Called = true;
          resolve({ outcome: "confirmed", ledger: 1005, successful: true });
        } else if (txHash === "h3") {
          h3Called = true;
          resolve({ outcome: "confirmed", ledger: 1005, successful: true });
        }
      });
    });

    startReconciler({ ...BASE_CONFIG, concurrencyLimit: 1 });
    const summary = await runOneTick({ ...BASE_CONFIG, concurrencyLimit: 1 });

    // Wait slightly
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h1Called).toBe(true);
    // Since stopReconciler() aborted and cleared the queue, h2 and h3 should never run
    expect(h2Called).toBe(false);
    expect(h3Called).toBe(false);

    expect(getActiveCount()).toBe(0);
    expect(getQueueCount()).toBe(0);
  });
});
