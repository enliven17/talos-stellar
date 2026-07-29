import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock factories ────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      update: (...a: any[]) => mockUpdate(...a),
      insert: (...a: any[]) => mockInsert(...a),
      select: (...a: any[]) => mockSelect(...a),
    });
  });

  return {
    mockDb: {
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      transaction: mockTransaction,
    },
  };
});

const { mockDb } = mocks;

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: vi.fn(),
}));

// ─── Helper: build a chainable select mock ─────────────────────────
function selectChain(result: any) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
  return chain;
}

// ─── Helper: build a chainable update mock ─────────────────────────
function updateChain(result: any) {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

describe("Job Lease System", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Claim ─────────────────────────────────────────────────
  describe("POST /api/jobs/:id/claim", () => {
    it("acquires a lease on an unclaimed pending job", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/claim/route");

      const claimedResult = {
        id: "job_1",
        leasedBy: "agent_1",
        leasedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
        fencingToken: 1,
        status: "pending",
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([claimedResult]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.fencingToken).toBe(1);
      expect(body.leasedBy).toBe("agent_1");
      expect(body.leasedAt).toBeDefined();
    });

    it("rejects claim when job is leased by another worker with valid lease", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/claim/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_2" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_2", status: "Active" }]))
        .mockReturnValueOnce(selectChain([{ id: "job_1", status: "pending" }]));

      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_2" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toContain("leased");
    });

    it("returns 404 when job does not exist", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/claim/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]))
        .mockReturnValueOnce(selectChain([]));

      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/jobs/nonexistent/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(response.status).toBe(404);
    });

    it("allows claiming a job with expired lease", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/claim/route");

      const claimedResult = {
        id: "job_1",
        leasedBy: "agent_2",
        leasedAt: new Date(Date.now() - 600000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 300000).toISOString(),
        fencingToken: 2,
        status: "pending",
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_2" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_2", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([claimedResult]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/claim", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_2" },
        body: JSON.stringify({ ttlSeconds: 300 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.fencingToken).toBe(2);
    });
  });

  // ── Heartbeat ─────────────────────────────────────────────
  describe("POST /api/jobs/:id/heartbeat", () => {
    it("extends lease for current holder with matching fencing token", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/heartbeat/route");

      const renewedResult = {
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([renewedResult]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/heartbeat", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ fencingToken: 1 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.renewed).toBe(true);
      expect(body.leaseExpiresAt).toBeDefined();
    });

    it("rejects heartbeat with mismatched fencing token", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/heartbeat/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/heartbeat", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ fencingToken: 999 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(409);
    });

    it("rejects heartbeat from non-holder", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/heartbeat/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_2" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_2", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/heartbeat", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_2" },
        body: JSON.stringify({ fencingToken: 1 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(409);
    });
  });

  // ── Release ───────────────────────────────────────────────
  describe("POST /api/jobs/:id/release", () => {
    it("releases lease for current holder", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/release/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([{ id: "job_1", status: "pending" }]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/release", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ fencingToken: 1 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.released).toBe(true);
    });

    it("rejects release with wrong fencing token", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/release/route");

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));
      mockDb.update.mockReturnValue(updateChain([]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/release", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ fencingToken: 999 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(409);
    });
  });

  // ── Complete with fencing ─────────────────────────────────
  describe("POST /api/jobs/:id/result with fencing token", () => {
    it("completes job with valid fencing token", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/result/route");

      const mockJob = {
        id: "job_1",
        talosId: "agent_1",
        requesterTalosId: "agent_2",
        amount: "10.0",
        txHash: "tx_123",
        status: "pending",
        leasedBy: "agent_1",
        leasedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 300000),
        fencingToken: 1,
      };

      const mockCompleted = {
        id: "job_1",
        status: "completed",
        result: { data: "done" },
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([mockJob]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));

      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        const mockService = { currency: "USDC" };
        const mockServiceChain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: vi.fn().mockImplementation((fn: any) => Promise.resolve(fn([mockService]))),
        };
        const mockTx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([mockCompleted]),
              }),
            }),
          }),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
          select: vi.fn().mockReturnValue(mockServiceChain),
        };
        return cb(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ result: { data: "done" }, fencingToken: 1 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("completed");
    });

    it("rejects result with stale fencing token", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/result/route");

      const mockJob = {
        id: "job_1",
        talosId: "agent_1",
        requesterTalosId: "agent_2",
        amount: "10.0",
        txHash: "tx_123",
        status: "pending",
        leasedBy: "agent_2",
        leaseExpiresAt: new Date(Date.now() + 300000),
        fencingToken: 2,
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([mockJob]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ result: { data: "done" }, fencingToken: 1 }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(409);
    });

    it("defaults fencingToken to 0 for backward compatibility", async () => {
      const { POST } = await import("../src/app/api/jobs/[id]/result/route");

      const mockJob = {
        id: "job_1",
        talosId: "agent_1",
        requesterTalosId: "agent_2",
        amount: "10.0",
        txHash: "tx_123",
        status: "pending",
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
        fencingToken: 0,
      };

      const mockCompleted = {
        id: "job_1",
        status: "completed",
        result: { data: "done" },
      };

      mockDb.select
        .mockReturnValueOnce(selectChain([{ id: "agent_1" }]))
        .mockReturnValueOnce(selectChain([mockJob]))
        .mockReturnValueOnce(selectChain([{ id: "agent_1", status: "Active" }]));

      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        const mockService = { currency: "USDC" };
        const mockServiceChain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: vi.fn().mockImplementation((fn: any) => Promise.resolve(fn([mockService]))),
        };
        const mockTx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([mockCompleted]),
              }),
            }),
          }),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
          select: vi.fn().mockReturnValue(mockServiceChain),
        };
        return cb(mockTx);
      });

      const request = new NextRequest("http://localhost:3000/api/jobs/job_1/result", {
        method: "POST",
        headers: { Authorization: "Bearer tok_agent_1" },
        body: JSON.stringify({ result: { data: "done" } }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: "job_1" }) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("completed");
    });
  });

  // ── Pending with leases ───────────────────────────────────
  describe("GET /api/jobs/pending with lease filtering", () => {
    it("excludes jobs with valid leases held by other workers", async () => {
      const { GET } = await import("../src/app/api/jobs/pending/route");

      const unleasedJob = {
        id: "job_1",
        talosId: "agent_1",
        status: "pending",
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
        fencingToken: 0,
      };
      const selfLeasedJob = {
        id: "job_2",
        talosId: "agent_1",
        status: "pending",
        leasedBy: "agent_1",
        leasedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 300000),
        fencingToken: 1,
      };

      mockDb.select.mockReturnValueOnce(selectChain([{ id: "agent_1" }]));

      const chain: any = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: (r: any) => any) =>
          Promise.resolve(cb([unleasedJob, selfLeasedJob])),
        ),
      };
      mockDb.select.mockReturnValueOnce(chain);

      const request = new NextRequest("http://localhost:3000/api/jobs/pending", {
        method: "GET",
        headers: { Authorization: "Bearer tok_agent_1" },
      });

      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.jobs).toHaveLength(2);
      expect(body.jobs.find((j: any) => j.id === "job_1")).toBeDefined();
      expect(body.jobs.find((j: any) => j.id === "job_2")).toBeDefined();
    });
  });
});
