/** @vitest-environment node */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const mockCreatorKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const CREATOR_KEY = mockCreatorKeypair.publicKey();
const NON_OWNER_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

const mocks = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  const mockTransaction = vi.fn();

  return {
    mockFindFirst,
    mockSelect,
    mockUpdate,
    mockTransaction,
    mockDb: {
      query: {
        tlsTalos: {
          findFirst: mockFindFirst,
        },
      },
      select: mockSelect,
      update: mockUpdate,
      transaction: mockTransaction,
    },
  };
});

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/schemas", async () => {
  const { z } = await vi.importActual<typeof import("zod")>("zod");
  const retireAgentSchema = z.object({
    reason: z.string().min(1).max(1000),
    supersededBy: z.string().nullable().optional(),
    stellarPublicKey: z.string().min(1),
    signature: z.string().min(1),
    message: z.string().min(1),
    drainJobs: z.boolean().optional(),
  });
  return {
    retireAgentSchema,
    parseBody: async (request: any, schema: any) => {
      try {
        const body = await request.json();
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          return { data: null, error: Response.json({ error: "Validation failed" }, { status: 400 }) };
        }
        return { data: parsed.data, error: null };
      } catch {
        return { data: null, error: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
      }
    },
  };
});

vi.mock("@/lib/governance/events", () => ({
  LIFECYCLE_EVENTS: {
    RETIRED: "agent.lifecycle.retired",
  },
  emitLifecycleEvent: vi.fn(async () => ({ id: "evt_1", sequence: 1, deduped: false })),
}));

function selectChain(result: any) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
  return chain;
}

describe("Retire and Lifecycle Checklist Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/talos/:id/retire", () => {
    it("returns 404 when agent is not found", async () => {
      const { GET } = await import("../src/app/api/talos/[id]/retire/route");
      mocks.mockFindFirst.mockResolvedValueOnce(null);

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + CREATOR_KEY);
      const res = await GET(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("TALOS not found");
    });

    it("returns 401 when viewer address is missing", async () => {
      const { GET } = await import("../src/app/api/talos/[id]/retire/route");
      mocks.mockFindFirst.mockResolvedValueOnce({
        id: "agent_1",
        creatorPublicKey: CREATOR_KEY,
        walletPublicKey: null,
      });

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire");
      const res = await GET(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Viewer address is required");
    });

    it("returns 403 when viewer is not the agent owner", async () => {
      const { GET } = await import("../src/app/api/talos/[id]/retire/route");
      mocks.mockFindFirst.mockResolvedValueOnce({
        id: "agent_1",
        creatorPublicKey: CREATOR_KEY,
        walletPublicKey: null,
      });

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + NON_OWNER_KEY);
      const res = await GET(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("only agent owner can access");
    });

    it("returns checklist showing blocking obligations when in-flight jobs exist", async () => {
      const { GET } = await import("../src/app/api/talos/[id]/retire/route");
      mocks.mockFindFirst.mockResolvedValueOnce({
        id: "agent_1",
        status: "Active",
        agentName: "agent-1",
        creatorPublicKey: CREATOR_KEY,
        walletPublicKey: null,
        agentOnline: true,
        retiredAt: null,
      });

      // 2 in-flight commerce jobs, 0 pending approvals
      mocks.mockSelect
        .mockReturnValueOnce(selectChain([{ id: "job_1" }, { id: "job_2" }]))
        .mockReturnValueOnce(selectChain([]));

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + CREATOR_KEY);
      const res = await GET(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.talosId).toBe("agent_1");
      expect(body.isOwner).toBe(true);
      expect(body.canRetire).toBe(false);

      const jobsObligation = body.obligations.find((o: any) => o.id === "in_flight_jobs");
      expect(jobsObligation.satisfied).toBe(false);
      expect(jobsObligation.blocking).toBe(true);
      expect(jobsObligation.count).toBe(2);

      // Verify private details are not exposed
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("secretKey");
    });

    it("returns canRetire: true when agent is paused and all obligations are cleared", async () => {
      const { GET } = await import("../src/app/api/talos/[id]/retire/route");
      mocks.mockFindFirst.mockResolvedValueOnce({
        id: "agent_1",
        status: "Paused",
        agentName: "agent-1",
        creatorPublicKey: CREATOR_KEY,
        walletPublicKey: null,
        agentOnline: false,
        retiredAt: null,
      });

      // 0 in-flight jobs, 0 pending approvals
      mocks.mockSelect
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([]));

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + CREATOR_KEY);
      const res = await GET(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.canRetire).toBe(true);

      const retireAction = body.allowedNextActions.find((a: any) => a.action === "retire");
      expect(retireAction.enabled).toBe(true);
    });
  });

  describe("POST /api/talos/:id/retire", () => {
    it("returns 409 Conflict when retiring an agent with in-flight jobs and drainJobs is default", async () => {
      const { POST } = await import("../src/app/api/talos/[id]/retire/route");

      const message = `Retire TALOS agent_1`;
      const signature = mockCreatorKeypair.sign(Buffer.from(message, "utf8")).toString("base64");

      mocks.mockTransaction.mockImplementation(async (callback: any) => {
        const tx = {
          query: {
            tlsTalos: {
              findFirst: vi.fn().mockResolvedValue({
                id: "agent_1",
                creatorPublicKey: CREATOR_KEY,
                walletPublicKey: null,
                retiredAt: null,
                status: "Active",
              }),
            },
          },
          select: vi.fn().mockReturnValue(selectChain([{ id: "job_1" }])),
        };
        return callback(tx);
      });

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "Obsolescence",
          stellarPublicKey: CREATOR_KEY,
          signature,
          message,
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("in-flight job(s)");
      expect(body.code).toBe("LIFECYCLE_PREREQUISITE_FAILED");
    });

    it("allows retirement when in-flight jobs exist if drainJobs: false is specified", async () => {
      const { POST } = await import("../src/app/api/talos/[id]/retire/route");

      const message = `Retire TALOS agent_1`;
      const signature = mockCreatorKeypair.sign(Buffer.from(message, "utf8")).toString("base64");

      const mockUpdated = {
        id: "agent_1",
        agentName: "agent-1",
        retiredAt: new Date(),
        retiredReason: "Forced retirement",
        supersededBy: null,
      };

      mocks.mockTransaction.mockImplementation(async (callback: any) => {
        const tx = {
          query: {
            tlsTalos: {
              findFirst: vi.fn().mockResolvedValue({
                id: "agent_1",
                creatorPublicKey: CREATOR_KEY,
                walletPublicKey: null,
                retiredAt: null,
                status: "Active",
              }),
            },
          },
          select: vi.fn().mockReturnValue(selectChain([{ id: "job_1" }])),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([mockUpdated]),
          }),
        };
        return callback(tx);
      });

      const req = new NextRequest("http://localhost:3000/api/talos/agent_1/retire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "Forced retirement",
          stellarPublicKey: CREATOR_KEY,
          signature,
          message,
          drainJobs: false,
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: "agent_1" }) });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("agent_1");
      expect(body.retiredReason).toBe("Forced retirement");
    });
  });
});
