import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST as createJobPOST } from "../src/app/api/talos/[id]/jobs/route";
import { POST as completeJobPOST } from "../src/app/api/jobs/[id]/result/route";
import { NextRequest } from "next/server";
import { tlsCommerceJobs, tlsRevenues } from "../src/db/schema";
import { resolveTalosFromRequest } from "@/lib/auth";

// Use vi.hoisted to declare mock functions so they are hoisted before vi.mock calls,
// preventing any ReferenceError during test execution.
const mocks = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

const { mockDb } = mocks;

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/auth", () => ({
  resolveTalosFromRequest: vi.fn(),
  verifyAgentApiKey: vi.fn(),
}));

// Mock external SDKs / methods to avoid external network calls
vi.mock("@stellar/stellar-sdk", () => {
  return {
    Horizon: {
      Server: class {
        submitTransaction = vi.fn();
      },
    },
    TransactionBuilder: {
      fromXDR: vi.fn(),
    },
    Networks: {
      TESTNET: "TESTNET",
    },
    Asset: class {
      constructor(public code: string, public issuer: string) {}
    },
  };
});

const mockSelectChain = (result: unknown[]) => {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    then: vi.fn(),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.then.mockImplementation(
    (callback: (rows: unknown[]) => unknown) => callback(result),
  );
  return chain;
};

/**
 * Build an insert mock that supports both .values().returning() (for upsert)
 * and .values() alone (for side-effect-only inserts inside transactions).
 */
const mockInsertChain = (returningResult: any[] = []) => {
  const chain: any = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningResult),
  };
  return chain;
};

describe("Async Jobs Revenue Recording Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/talos/[id]/jobs — Create Async Job", () => {
    it("successfully creates a pending job and does NOT record revenue immediately", async () => {
      const mockService = {
        id: "srv_1",
        talosId: "agent_1",
        serviceName: "research",
        price: "10.0",
        fulfillmentMode: "async",
        currency: "USDC",
      };

      const mockTalos = {
        id: "agent_1",
        agentOnline: true,
        name: "Test Agent",
        agentWalletAddress: "G12345",
      };

      const mockJob = {
        id: "job_1",
        status: "pending",
        serviceName: "research",
      };

      // Mock select calls in order:
      // 1. service select (tlsCommerceServices)
      // 2. talos select   (tlsTalos)
      // 3. quota config   (tlsQuotaConfigs — resolveQuotaConfig; returns empty → disabled fallback)
      // 4. duplicate job check (tlsCommerceJobs — returns empty, no duplicate)
      mockDb.select
        .mockReturnValueOnce(mockSelectChain([mockService]))
        .mockReturnValueOnce(mockSelectChain([mockTalos]))
        .mockReturnValueOnce(mockSelectChain([]))   // quota config → safe fallback (disabled)
        .mockReturnValueOnce(mockSelectChain([]));  // duplicate job check

      // quota insert (upsert into tlsQuotaUsage) — returns a row with count=1
      mockDb.insert
        .mockReturnValueOnce(mockInsertChain([{ count: 1 }]));

      // Mock transaction
      const mockTxInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockJob]),
        }),
      });

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          insert: mockTxInsert,
        };
        return callback(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/talos/agent_1/jobs", {
        method: "POST",
        body: JSON.stringify({
          buyerPublicKey: "GBUYER",
          txHash: "tx_123",
          payload: {},
        }),
      });

      const response = await createJobPOST(request, {
        params: Promise.resolve({ id: "agent_1" }),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.status).toBe("pending");
      expect(body.jobId).toBe("job_1");

      // Verify that tx.insert was called for tlsCommerceJobs, but NOT for tlsRevenues
      expect(mockTxInsert).toHaveBeenCalledTimes(1);
      const insertedTable = mockTxInsert.mock.calls[0][0];
      expect(insertedTable).toBe(tlsCommerceJobs);
    });
  });

  describe("POST /api/jobs/[id]/result — Complete Job and Record Revenue", () => {
    const mockService = {
      currency: "USDC",
    };

    const mockJob = {
      id: "job_1",
      talosId: "agent_1",
      amount: "10.0",
      txHash: "tx_123",
      status: "pending",
    };

    const mockUpdatedJob = {
      id: "job_1",
      status: "completed",
    };

    beforeEach(() => {
      vi.mocked(resolveTalosFromRequest).mockResolvedValue({
        ok: true,
        talos: { id: "agent_1" },
      });
    });

    it("records revenue on completing a previously pending job", async () => {
      // resolveTalosFromRequest is mocked, so only the job fetch is needed
      mockDb.select
        .mockReturnValueOnce(mockSelectChain([mockJob]));

      const mockTxUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mockUpdatedJob]),
          }),
        }),
      });

      const mockTxInsert = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      });

      const mockTxSelect = vi.fn().mockReturnValue(mockSelectChain([mockService]));

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          update: mockTxUpdate,
          select: mockTxSelect,
          insert: mockTxInsert,
        };
        return callback(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: {
          Authorization: "Bearer mock_token",
        },
        body: JSON.stringify({
          result: { data: "success" },
        }),
      });

      const response = await completeJobPOST(request, {
        params: Promise.resolve({ id: "job_1" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("completed");

      // Verify that tx.insert was called to record the revenue
      expect(mockTxInsert).toHaveBeenCalledTimes(1);
      const insertedTable = mockTxInsert.mock.calls[0][0];
      expect(insertedTable).toBe(tlsRevenues);

      // Verify the values inserted
      const valuesChain = mockTxInsert.mock.results[0].value;
      expect(valuesChain.values).toHaveBeenCalledWith({
        talosId: "agent_1",
        amount: "10.0",
        currency: "USDC",
        source: "commerce",
        txHash: "tx_123",
      });
    });

    it("does NOT record duplicate revenue if the job was already completed", async () => {
      const mockAlreadyCompletedJob = {
        ...mockJob,
        status: "completed",
      };

      mockDb.select
        .mockReturnValueOnce(mockSelectChain([mockAlreadyCompletedJob]));

      const mockTxUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mockUpdatedJob]),
          }),
        }),
      });

      const mockTxInsert = vi.fn();

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          update: mockTxUpdate,
          insert: mockTxInsert,
        };
        return callback(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: {
          Authorization: "Bearer mock_token",
        },
        body: JSON.stringify({
          result: { data: "success-again" },
        }),
      });

      const response = await completeJobPOST(request, {
        params: Promise.resolve({ id: "job_1" }),
      });

      // The pre-guard catches completed status before the transaction
      expect(response.status).toBe(409);
      // Verify that the transaction was never entered
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("does NOT record revenue when a concurrent completion loses the pending-state CAS", async () => {
      // Both workers may read "pending" before either transaction commits.
      // The UPDATE includes status='pending', so the loser returns no row.
      mockDb.select
        .mockReturnValueOnce(mockSelectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(mockSelectChain([mockJob]));

      const mockTxUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      const mockTxInsert = vi.fn();

      mockDb.transaction.mockImplementation(async (callback) => {
        const mockTx = {
          update: mockTxUpdate,
          insert: mockTxInsert,
          select: vi.fn(),
        };
        return callback(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: {
          Authorization: "Bearer mock_token",
        },
        body: JSON.stringify({
          result: { data: "concurrent-result" },
        }),
      });

      const response = await completeJobPOST(request, {
        params: Promise.resolve({ id: "job_1" }),
      });

      expect(response.status).toBe(409);
      expect(mockTxUpdate).toHaveBeenCalledTimes(1);
      expect(mockTxInsert).not.toHaveBeenCalled();
    });
  });
});
