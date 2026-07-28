import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isRetryableDbError,
  calculateJitteredDelay,
  withTransactionRetry,
  SerializationRetryExhaustedError,
} from "../src/db/db-retry";
import { logger } from "../src/lib/logger";

vi.mock("../src/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("db-retry unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRetryableDbError classification", () => {
    it("identifies PostgreSQL serialization failure (40001)", () => {
      expect(isRetryableDbError({ code: "40001" })).toBe(true);
      expect(isRetryableDbError({ sqlState: "40001" })).toBe(true);
      expect(isRetryableDbError({ cause: { code: "40001" } })).toBe(true);
    });

    it("identifies PostgreSQL deadlock (40P01)", () => {
      expect(isRetryableDbError({ code: "40P01" })).toBe(true);
    });

    it("identifies PostgreSQL lock not available (55P03)", () => {
      expect(isRetryableDbError({ code: "55P03" })).toBe(true);
    });

    it("identifies transient connection error codes", () => {
      expect(isRetryableDbError({ code: "08000" })).toBe(true);
      expect(isRetryableDbError({ code: "08006" })).toBe(true);
      expect(isRetryableDbError({ code: "57P01" })).toBe(true);
      expect(isRetryableDbError({ code: "ECONNRESET" })).toBe(true);
      expect(isRetryableDbError({ code: "ETIMEDOUT" })).toBe(true);
    });

    it("identifies retryable error messages", () => {
      expect(
        isRetryableDbError(new Error("could not serialize access due to concurrent update"))
      ).toBe(true);
      expect(isRetryableDbError(new Error("deadlock detected"))).toBe(true);
      expect(isRetryableDbError(new Error("connection terminated abruptly"))).toBe(true);
    });

    it("rejects non-retryable errors", () => {
      expect(isRetryableDbError({ code: "23505" })).toBe(false); // unique_violation
      expect(isRetryableDbError({ code: "23503" })).toBe(false); // foreign_key_violation
      expect(isRetryableDbError({ code: "42703" })).toBe(false); // undefined_column
      expect(isRetryableDbError(new Error("syntax error at or near WHERE"))).toBe(false);
      expect(isRetryableDbError(null)).toBe(false);
      expect(isRetryableDbError(undefined)).toBe(false);
      expect(isRetryableDbError("string error")).toBe(false);
    });
  });

  describe("calculateJitteredDelay", () => {
    it("returns a bounded integer delay within [0, maxDelay]", () => {
      for (let i = 0; i < 50; i++) {
        const delay = calculateJitteredDelay(1, 50, 1000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(50);
      }

      for (let i = 0; i < 50; i++) {
        const delay = calculateJitteredDelay(5, 50, 200);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("withTransactionRetry execution flow", () => {
    it("executes successfully on first attempt when no error occurs", async () => {
      const mockTx = vi.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => cb({ tx: "instance" }));

      const result = await withTransactionRetry(
        async () => {
          return "success";
        },
        { category: "TOKEN", dbInstance: { transaction: mockTx } }
      );

      expect(result).toBe("success");
      expect(mockTx).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("retries on serialization failure and returns result on retry success", async () => {
      let attempts = 0;
      const mockTx = vi.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        attempts++;
        if (attempts === 1) {
          const err = new Error("could not serialize access due to concurrent update");
          (err as any).code = "40001";
          throw err;
        }
        return cb({ tx: "instance" });
      });

      const result = await withTransactionRetry(
        async () => {
          return { done: true };
        },
        {
          category: "MONEY",
          initialDelayMs: 10,
          maxDelayMs: 20,
          dbInstance: { transaction: mockTx },
        }
      );

      expect(result).toEqual({ done: true });
      expect(attempts).toBe(2);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "MONEY",
          attempt: 1,
          maxRetries: 5,
          errorCode: "40001",
        }),
        "db_transaction_retry_attempt"
      );
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "MONEY",
          attempts: 2,
        }),
        "db_transaction_retry_success"
      );
    });

    it("throws SerializationRetryExhaustedError when maxRetries is exceeded", async () => {
      let attempts = 0;
      const mockTx = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("serialization failure");
        (err as any).code = "40001";
        throw err;
      });

      await expect(
        withTransactionRetry(
          async () => {},
          {
            category: "PATRON",
            maxRetries: 3,
            initialDelayMs: 5,
            maxDelayMs: 10,
            dbInstance: { transaction: mockTx },
          }
        )
      ).rejects.toThrow(SerializationRetryExhaustedError);

      expect(attempts).toBe(4); // 1 initial + 3 retries
      expect(logger.warn).toHaveBeenCalledTimes(3);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "PATRON",
          attempts: 4,
          maxRetries: 3,
          errorCode: "40001",
        }),
        "db_transaction_retry_exhausted"
      );
    });

    it("immediately throws non-retryable error without retrying", async () => {
      let attempts = 0;
      const mockTx = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("duplicate key value violates unique constraint");
        (err as any).code = "23505";
        throw err;
      });

      await expect(
        withTransactionRetry(
          async () => {},
          {
            category: "JOB",
            dbInstance: { transaction: mockTx },
          }
        )
      ).rejects.toThrow("duplicate key value violates unique constraint");

      expect(attempts).toBe(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("bypasses retry logic when enabled: false", async () => {
      let attempts = 0;
      const mockTx = vi.fn().mockImplementation(async () => {
        attempts++;
        const err = new Error("serialization failure");
        (err as any).code = "40001";
        throw err;
      });

      await expect(
        withTransactionRetry(
          async () => {},
          {
            category: "GENESIS",
            enabled: false,
            dbInstance: { transaction: mockTx },
          }
        )
      ).rejects.toThrow("serialization failure");

      expect(attempts).toBe(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("verifies rollback isolation: mutated state in aborted callback is not committed", async () => {
      const dbState: string[] = [];
      let attempts = 0;

      const mockTx = vi.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        attempts++;
        const currentTxState: string[] = [];
        try {
          const res = await cb({
            insert: (item: string) => currentTxState.push(item),
          });
          // Commit tx state to dbState on transaction success
          dbState.push(...currentTxState);
          return res;
        } catch (txErr) {
          // Roll back: tx state discarded
          throw txErr;
        }
      });

      const result = await withTransactionRetry(
        async (tx: any) => {
          tx.insert(`attempt_${attempts}_item`);
          if (attempts === 1) {
            const err = new Error("serialization failure");
            (err as any).code = "40001";
            throw err;
          }
          return "committed";
        },
        {
          category: "JOB",
          initialDelayMs: 5,
          maxDelayMs: 10,
          dbInstance: { transaction: mockTx },
        }
      );

      expect(result).toBe("committed");
      expect(attempts).toBe(2);
      // Attempt 1 item was rolled back, only attempt 2 item was committed
      expect(dbState).toEqual(["attempt_2_item"]);
    });
  });
});
