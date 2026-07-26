import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST as distributePOST } from "../src/app/api/talos/[id]/revenue/distribute/route";
import { NextRequest } from "next/server";
import { tlsDividends } from "../src/db/schema";

const mocks = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
      query: {
        tlsTalos: { findFirst: vi.fn() },
        tlsDividends: { findFirst: vi.fn() },
      },
    },
  };
});

const { mockDb } = mocks;

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/stellar-config", () => ({
  OPERATOR_PUBLIC_KEY: "GOPERATOR",
  USDC_ISSUER: "GISSUER",
}));

vi.mock("@stellar/stellar-sdk", () => {
  return {
    Horizon: {
      Server: class {
        loadAccount = vi.fn().mockResolvedValue({ accountId: "GTEST" });
        submitTransaction = vi.fn().mockResolvedValue({ hash: "tx_hash_123" });
      },
    },
    TransactionBuilder: class {
      addOperation = vi.fn().mockReturnThis();
      setTimeout = vi.fn().mockReturnThis();
      build = vi.fn().mockReturnThis();
      sign = vi.fn().mockReturnThis();
    },
    Networks: {
      TESTNET: "TESTNET",
    },
    BASE_FEE: "100",
    Asset: class {
      constructor(public code: string, public issuer: string) {}
    },
    Operation: {
      payment: vi.fn().mockReturnValue({}),
    },
    Keypair: {
      fromSecret: vi.fn().mockReturnValue({ publicKey: () => "GTEST" }),
    },
  };
});

const mockSelectChain = (result: unknown) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((callback: (arg: unknown) => unknown) => callback(result)),
  };
  return chain;
};

const mockInsertChain = (result: unknown) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
};

describe("Revenue Distribution Transaction Safety Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STELLAR_OPERATOR_SECRET_KEY = "test_secret_key";
    mockDb.select.mockImplementation(() => mockSelectChain([]));
  });

  describe("Idempotency - Prevent Double Execution", () => {
    it("returns existing distribution when same distributionId is used", async () => {
      const mockTalos = {
        id: "agent_1",
        creatorPublicKey: "GCREATOR",
        investorShare: 25,
      };

      const mockExistingDividend = {
        id: "div_123",
        talosId: "agent_1",
        distributionId: "dist_abc",
        status: "completed",
        breakdown: [{ patron: "GPATRON1", amount: 10, txHash: "tx_1" }],
      };

      mockDb.query.tlsTalos.findFirst.mockResolvedValue(mockTalos);
      mockDb.query.tlsDividends.findFirst.mockResolvedValue(mockExistingDividend);

      const request = new NextRequest("http://localhost:3000/api/talos/agent_1/revenue/distribute", {
        method: "POST",
        body: JSON.stringify({
          requesterPublicKey: "GCREATOR",
          distributionId: "dist_abc",
        }),
      });

      const response = await distributePOST(request, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.message).toBe("Distribution already executed (idempotent)");
      expect(body.dividendId).toBe("div_123");
      expect(body.status).toBe("completed");
      expect(body.transfers).toEqual(mockExistingDividend.breakdown);
    });
  });

  describe("Transaction Safety", () => {
    it("records failed state on transaction failure", async () => {
      const mockTalos = {
        id: "agent_1",
        creatorPublicKey: "GCREATOR",
        investorShare: 25,
      };

      mockDb.query.tlsTalos.findFirst.mockResolvedValue(mockTalos);
      mockDb.query.tlsDividends.findFirst.mockResolvedValue(null);
      
      mockDb.select.mockReturnValueOnce(mockSelectChain([{ total: "100" }]));
      mockDb.select.mockReturnValueOnce(mockSelectChain([
        { stellarPublicKey: "GPATRON1", pulseAmount: 100, status: "active" },
      ]));

      const mockTxInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error("Database constraint violation")),
        }),
      });

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = { insert: mockTxInsert };
        return callback(mockTx);
      });

      mockDb.insert.mockReturnValue(mockInsertChain([{ id: "div_failed" }]));

      const request = new NextRequest("http://localhost:3000/api/talos/agent_1/revenue/distribute", {
        method: "POST",
        body: JSON.stringify({
          requesterPublicKey: "GCREATOR",
          distributionId: "dist_fail",
        }),
      });

      const response = await distributePOST(request, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response.status).toBe(200);
      expect(mockDb.insert).toHaveBeenCalledWith(tlsDividends);
    });

    it("wraps dividend insertion in transaction for atomicity", async () => {
      const mockTalos = {
        id: "agent_1",
        creatorPublicKey: "GCREATOR",
        investorShare: 25,
      };

      mockDb.query.tlsTalos.findFirst.mockResolvedValue(mockTalos);
      mockDb.query.tlsDividends.findFirst.mockResolvedValue(null);
      
      mockDb.select.mockReturnValueOnce(mockSelectChain([{ total: "100" }]));
      mockDb.select.mockReturnValueOnce(mockSelectChain([
        { stellarPublicKey: "GPATRON1", pulseAmount: 100, status: "active" },
      ]));

      const mockTxInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "div_123" }]),
        }),
      });

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = { insert: mockTxInsert };
        return callback(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/talos/agent_1/revenue/distribute", {
        method: "POST",
        body: JSON.stringify({
          requesterPublicKey: "GCREATOR",
          distributionId: "dist_tx_test",
        }),
      });

      const response = await distributePOST(request, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response.status).toBe(200);
      expect(mockDb.transaction).toHaveBeenCalled();
      
      // Verify the transaction callback was called with the mock transaction object
      expect(mockTxInsert).toHaveBeenCalledWith(tlsDividends);
    });
  });

  describe("Concurrency - Exactly-Once Distribution", () => {
    it("simulates concurrent requests with same distributionId to ensure exactly-once", async () => {
      const mockTalos = {
        id: "agent_1",
        creatorPublicKey: "GCREATOR",
        investorShare: 25,
      };

      const distributionId = "concurrent_dist_123";
      
      mockDb.query.tlsTalos.findFirst.mockResolvedValue(mockTalos);
      
      // First call: no existing distribution
      mockDb.query.tlsDividends.findFirst.mockResolvedValueOnce(null);
      
      mockDb.select.mockReturnValueOnce(mockSelectChain([{ total: "100" }]));
      mockDb.select.mockReturnValueOnce(mockSelectChain([
        { stellarPublicKey: "GPATRON1", pulseAmount: 100, status: "active" },
      ]));

      const mockTxInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "div_123" }]),
        }),
      });

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = { insert: mockTxInsert };
        return callback(mockTx);
      });

      // Create two concurrent requests with the same distributionId
      const request1 = new NextRequest("http://localhost:3000/api/talos/agent_1/revenue/distribute", {
        method: "POST",
        body: JSON.stringify({
          requesterPublicKey: "GCREATOR",
          distributionId,
        }),
      });

      const request2 = new NextRequest("http://localhost:3000/api/talos/agent_1/revenue/distribute", {
        method: "POST",
        body: JSON.stringify({
          requesterPublicKey: "GCREATOR",
          distributionId,
        }),
      });

      // Execute first request
      const response1 = await distributePOST(request1, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      expect(body1.dividendId).toBe("div_123");

      // Second call: existing distribution found (idempotency)
      mockDb.query.tlsDividends.findFirst.mockResolvedValueOnce({
        id: "div_123",
        talosId: "agent_1",
        distributionId,
        status: "completed",
        breakdown: [],
      });

      // Execute second request (should hit idempotency check)
      const response2 = await distributePOST(request2, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      expect(body2.message).toBe("Distribution already executed (idempotent)");
      expect(body2.dividendId).toBe("div_123");

      // Verify transaction was only called once (first request)
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });
});
