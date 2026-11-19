import { describe, expect, it, vi, beforeEach } from "vitest";
import { ingestJobToLedger } from "../src/lib/reputation-ledger";
import { db } from "../src/db";

vi.mock("../src/db", () => {
  const queryBuilder = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  return { db: queryBuilder };
});

describe("reputation-ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ingestJobToLedger", () => {
    it("throws if job not found", async () => {
      vi.mocked((db as any).limit).mockResolvedValueOnce([]);
      await expect(ingestJobToLedger("missing")).rejects.toThrow("Job missing not found");
    });

    it("returns null for non-terminal jobs (e.g. pending)", async () => {
      vi.mocked((db as any).limit).mockResolvedValueOnce([{ id: "job1", status: "pending" }] as any);
      const res = await ingestJobToLedger("job1");
      expect(res).toBeNull();
      expect((db as any).insert).not.toHaveBeenCalled();
    });

    it("ingests a terminal job idempotently with basic signals", async () => {
      const mockJob = {
        id: "job2",
        status: "completed",
        talosId: "seller1",
        requesterTalosId: "buyer1",
        createdAt: new Date(),
        updatedAt: new Date(),
        txHash: "hash123",
        result: { some: "data" }
      };

      const mockInserted = { ...mockJob, hasResult: true, deadlineAt: null, refundAmount: null };
      vi.mocked((db as any).limit).mockResolvedValueOnce([mockJob]);
      vi.mocked((db as any).returning).mockResolvedValueOnce([mockInserted] as any);

      const res = await ingestJobToLedger("job2");
      expect(res).toEqual(mockInserted);
      expect((db as any).insert).toHaveBeenCalled();
      expect((db as any).onConflictDoUpdate).toHaveBeenCalled();
    });

    it("extracts and persists deadlines and refunds correctly", async () => {
      const mockJob = {
        id: "job3",
        status: "refunded",
        talosId: "seller1",
        requesterTalosId: "buyer2",
        createdAt: new Date(),
        updatedAt: new Date(),
        txHash: "hash456",
        payload: { deadlineAt: "2024-01-01T00:00:00.000Z" },
        result: { refundAmount: "50.00" }
      };

      const mockInserted = { 
        ...mockJob, 
        hasResult: true, 
        deadlineAt: new Date("2024-01-01T00:00:00.000Z"), 
        refundAmount: "50.00" 
      };
      
      vi.mocked((db as any).limit).mockResolvedValueOnce([mockJob]);
      vi.mocked((db as any).values).mockImplementationOnce((vals: any) => {
        expect(vals.deadlineAt).toEqual(new Date("2024-01-01T00:00:00.000Z"));
        expect(vals.refundAmount).toEqual("50.00");
        return { onConflictDoUpdate: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValueOnce([mockInserted]) } as any;
      });
      vi.mocked((db as any).returning).mockResolvedValueOnce([mockInserted] as any);

      const res = await ingestJobToLedger("job3");
      expect(res).toEqual(mockInserted);
    });

    it("handles repeats and unique counterparties without leaking private payload", async () => {
      const mockJob = {
        id: "job4",
        status: "disputed",
        talosId: "seller1",
        requesterTalosId: "buyer1", // Repeat counterparty
        createdAt: new Date(),
        updatedAt: new Date(),
        txHash: "hash789",
        payload: { privateField: "secret" },
        result: { privateOutcome: "hidden" }
      };

      const mockInserted = { 
        ...mockJob, 
        hasResult: true, 
        deadlineAt: null, 
        refundAmount: null 
      };
      vi.mocked((db as any).limit).mockResolvedValueOnce([mockJob] as any);
      vi.mocked((db as any).values).mockImplementationOnce((vals: any) => {
        expect(vals).not.toHaveProperty("payload");
        expect(vals).not.toHaveProperty("result");
        expect(vals.requesterTalosId).toBe("buyer1");
        return { onConflictDoUpdate: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValueOnce([mockInserted]) } as any;
      });
      vi.mocked((db as any).returning).mockResolvedValueOnce([mockInserted] as any);

      await ingestJobToLedger("job4");
    });
  });
});
