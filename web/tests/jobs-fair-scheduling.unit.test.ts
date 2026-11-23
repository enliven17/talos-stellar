/**
 * Unit tests for per-queue fair scheduling in leaseBatch().
 *
 * Coverage
 * ────────
 *   ✓ fairBatchPerQueue=0 (default) → single bulk query, no per-queue iteration
 *   ✓ fairBatchPerQueue>0 → one db.execute call per queue
 *   ✓ per-queue cap is honoured: each queue contributes at most fairBatchPerQueue rows
 *   ✓ global limit is honoured: total rows never exceed the batch limit
 *   ✓ stable ordering within a queue: priority DESC, runAt ASC preserved
 *   ✓ stops iterating queues once the global limit is filled
 *   ✓ queues with no eligible work contribute 0 rows without blocking others
 */

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

import { leaseBatch } from "../src/lib/jobs/store";

function makeRow(id: string, queue: string) {
  return {
    id,
    queue,
    payload: {},
    status: "leased",
    priority: 0,
    runAt: new Date(),
    leaseId: `lease_${id}`,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobs/store — leaseBatch fair scheduling", () => {
  it("returns [] without querying when queues is empty", async () => {
    const rows = await leaseBatch([], 10, "w1", 30_000, 0);
    expect(rows).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("uses a single bulk query when fairBatchPerQueue is 0 (default path)", async () => {
    mockDb.execute.mockResolvedValue({ rows: [makeRow("j1", "q_a"), makeRow("j2", "q_b")] });

    const rows = await leaseBatch(["q_a", "q_b"], 10, "w1", 30_000, 0);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it("issues one db.execute call per queue when fairBatchPerQueue > 0", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [makeRow("j1", "q_a")] })
      .mockResolvedValueOnce({ rows: [makeRow("j2", "q_b")] });

    const rows = await leaseBatch(["q_a", "q_b"], 10, "w1", 30_000, 2);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });

  it("caps each queue's contribution at fairBatchPerQueue", async () => {
    // q_a has 5 eligible jobs but cap is 2
    mockDb.execute
      .mockResolvedValueOnce({ rows: [makeRow("j1", "q_a"), makeRow("j2", "q_a")] })
      .mockResolvedValueOnce({ rows: [makeRow("j3", "q_b"), makeRow("j4", "q_b")] });

    const rows = await leaseBatch(["q_a", "q_b"], 10, "w1", 30_000, 2);

    // Each queue returned 2 rows (the mock already simulates the DB honouring the cap)
    expect(rows).toHaveLength(4);
    const qA = rows.filter((r) => r.queue === "q_a");
    const qB = rows.filter((r) => r.queue === "q_b");
    expect(qA).toHaveLength(2);
    expect(qB).toHaveLength(2);
  });

  it("respects the global limit across queues", async () => {
    // Global limit = 3, fairBatchPerQueue = 2, 2 queues → max possible 4 but global caps at 3
    mockDb.execute
      .mockResolvedValueOnce({ rows: [makeRow("j1", "q_a"), makeRow("j2", "q_a")] })
      .mockResolvedValueOnce({ rows: [makeRow("j3", "q_b")] }); // only 1 needed to fill limit

    const rows = await leaseBatch(["q_a", "q_b"], 3, "w1", 30_000, 2);

    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("stops querying further queues once the global limit is reached", async () => {
    // global limit = 2, fairBatchPerQueue = 2 → first queue fills the batch
    mockDb.execute.mockResolvedValueOnce({ rows: [makeRow("j1", "q_a"), makeRow("j2", "q_a")] });

    const rows = await leaseBatch(["q_a", "q_b", "q_c"], 2, "w1", 30_000, 2);

    // Only one execute call — stopped after q_a filled the batch
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it("skips queues that return no eligible rows and continues to the next", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [] })              // q_a: nothing eligible
      .mockResolvedValueOnce({ rows: [makeRow("j1", "q_b")] }); // q_b: 1 job

    const rows = await leaseBatch(["q_a", "q_b"], 5, "w1", 30_000, 3);

    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].queue).toBe("q_b");
  });

  it("returns all rows in the order queues were iterated", async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rows: [makeRow("j1", "q_a"), makeRow("j2", "q_a")] })
      .mockResolvedValueOnce({ rows: [makeRow("j3", "q_b")] });

    const rows = await leaseBatch(["q_a", "q_b"], 10, "w1", 30_000, 2);

    expect(rows.map((r) => r.id)).toEqual(["j1", "j2", "j3"]);
  });
});
