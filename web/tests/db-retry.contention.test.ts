import { describe, it, expect } from "vitest";
import { withTransactionRetry } from "../src/db/db-retry";

describe("db-retry contention & concurrency integration tests", () => {
  it("resolves concurrent serialization conflicts deterministically across parallel tasks", async () => {
    const totalWorkers = 10;
    let conflictCount = 0;
    const completedWorkers: number[] = [];

    // Shared row counter state
    let sharedCounter = 0;
    const activeLocks = new Set<string>();

    const mockDb = {
      transaction: async (cb: (tx: any) => Promise<any>): Promise<any> => {
        const lockKey = "counter_row";

        // Simulate PostgreSQL repeatable read / serializable row isolation conflict
        if (activeLocks.has(lockKey)) {
          conflictCount++;
          const err = new Error("could not serialize access due to concurrent update");
          (err as any).code = "40001";
          throw err;
        }

        activeLocks.add(lockKey);
        try {
          // Artificial processing delay simulating DB operation
          await new Promise((resolve) => setTimeout(resolve, 5));
          const tx = {
            increment: () => {
              sharedCounter += 1;
              return sharedCounter;
            },
          };
          const res = await cb(tx);
          return res;
        } finally {
          activeLocks.delete(lockKey);
        }
      },
    };

    const workerTasks = Array.from({ length: totalWorkers }, (_, i) => {
      return withTransactionRetry(
        async (tx: any) => {
          const val = tx.increment();
          completedWorkers.push(i);
          return val;
        },
        {
          category: "MONEY",
          maxRetries: 20,
          initialDelayMs: 2,
          maxDelayMs: 20,
          dbInstance: mockDb,
        }
      );
    });

    const results = await Promise.all(workerTasks);

    expect(results.length).toBe(totalWorkers);
    expect(sharedCounter).toBe(totalWorkers);
    expect(completedWorkers.length).toBe(totalWorkers);
    expect(conflictCount).toBeGreaterThan(0);
  });

  it("handles duplicate delivery & retry contention cleanly", async () => {
    let attempts = 0;
    const executionLog: string[] = [];

    const mockDb = {
      transaction: async (cb: (tx: any) => Promise<any>): Promise<any> => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("lock not available");
          (err as any).code = "55P03";
          throw err;
        }
        return cb({
          recordJob: (id: string) => executionLog.push(`job_${id}_recorded`),
        });
      },
    };

    const result = await withTransactionRetry(
      async (tx: any) => {
        tx.recordJob("123");
        return { status: "completed" };
      },
      {
        category: "JOB",
        initialDelayMs: 5,
        maxDelayMs: 10,
        dbInstance: mockDb,
      }
    );

    expect(result).toEqual({ status: "completed" });
    expect(attempts).toBe(2);
    // Verified that the side effect ran in the winning transaction
    expect(executionLog).toEqual(["job_123_recorded"]);
  });
});
