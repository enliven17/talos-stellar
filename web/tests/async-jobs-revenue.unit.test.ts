import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST as createJobPOST } from "../src/app/api/talos/[id]/jobs/route";
import { POST as completeJobPOST } from "../src/app/api/jobs/[id]/result/route";
import { NextRequest } from "next/server";
import { tlsCommerceJobs, tlsRevenues } from "../src/db/schema";

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

const mockSelectChain = (result: any) => {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((callback) => callback(result)),
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

      // Mock select calls:
      // 1. service select
      // 2. talos select
      // 3. duplicate job check (returns empty list, i.e., no duplicate)
      mockDb.select
        .mockReturnValueOnce(mockSelectChain([mockService]))
        .mockReturnValueOnce(mockSelectChain([mockTalos]))
        .mockReturnValueOnce(mockSelectChain([]));

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

    it("records revenue on completing a previously pending job", async () => {
      // 1. authenticate (returns talos with callerTalosId)
      // 2. fetch job (returns pending job)
      mockDb.select
        .mockReturnValueOnce(mockSelectChain([{ id: "agent_1" }]))
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
        .mockReturnValueOnce(mockSelectChain([{ id: "agent_1" }]))
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

      expect(response.status).toBe(200);

      // Verify that tx.insert was NOT called since the job status was already "completed"
      expect(mockTxInsert).not.toHaveBeenCalled();
    });
  });
});
