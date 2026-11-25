/** @vitest-environment node */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";

const creator = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const CREATOR_KEY = creator.publicKey();

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  enqueue: vi.fn(),
  loadSummary: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: { tlsTalos: { findFirst: mocks.findFirst } },
    select: mocks.select,
    transaction: mocks.transaction,
  },
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
        const parsed = schema.safeParse(await request.json());
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
  LIFECYCLE_EVENTS: { RETIRED: "agent.lifecycle.retired" },
  emitLifecycleEvent: mocks.emit,
}));

vi.mock("@/lib/governance/retirement-reconciliation", () => ({
  enqueueRetirementReconciliation: mocks.enqueue,
  loadRetirementReconciliation: mocks.loadSummary,
}));

function selectChain(result: any) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
}

const MESSAGE = "Retire TALOS agent_1";

function retireRequest(opts: { reason: string; signer?: Keypair; claimed?: string }) {
  const signer = opts.signer ?? creator;
  const signature = signer.sign(Buffer.from(MESSAGE, "utf8")).toString("base64");
  return new NextRequest("http://localhost:3000/api/talos/agent_1/retire", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: opts.reason,
      stellarPublicKey: opts.claimed ?? signer.publicKey(),
      signature,
      message: MESSAGE,
    }),
  });
}

function mockTransaction(talos: Record<string, unknown>, updated?: Record<string, unknown>) {
  const tx = {
    query: { tlsTalos: { findFirst: vi.fn().mockResolvedValue(talos) } },
    select: vi.fn().mockReturnValue(selectChain([])),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    }),
  };
  mocks.transaction.mockImplementation(async (cb: any) => cb(tx));
  return tx;
}

const params = { params: Promise.resolve({ id: "agent_1" }) };
const retiredAt = new Date("2026-01-01T00:00:00.000Z");

const activeAgent = {
  id: "agent_1",
  creatorPublicKey: CREATOR_KEY,
  walletPublicKey: null,
  retiredAt: null,
  status: "Active",
};

const retiredAgent = {
  id: "agent_1",
  agentName: "agent-1",
  creatorPublicKey: CREATOR_KEY,
  walletPublicKey: null,
  retiredAt,
  retiredReason: "Obsolete",
  supersededBy: null,
  status: "Retired",
};

describe("POST /api/talos/:id/retire - reconciliation and idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    // Readiness check (#1605): no pending jobs, payments, or undistributed revenue.
    mocks.select.mockReturnValue(selectChain([]));
    mocks.emit.mockResolvedValue({ id: "evt_1", sequence: 1, deduped: false });
    mocks.enqueue.mockResolvedValue({ jobId: "job_1", created: true });
    mocks.loadSummary.mockResolvedValue(null);
  });

  it("creates the reconciliation run in the same transaction as the retirement", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    const tx = mockTransaction(activeAgent, {
      id: "agent_1",
      agentName: "agent-1",
      retiredAt,
      retiredReason: "Obsolete",
      supersededBy: null,
    });

    const res = await POST(retireRequest({ reason: "Obsolete" }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reconciliationJobId).toBe("job_1");
    expect(body).not.toHaveProperty("replayed");
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(tx, { talosId: "agent_1", requestedBy: CREATOR_KEY });
  });

  it("surfaces a failed enqueue as 500 so the whole retirement is retried, not half-applied", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    mockTransaction(activeAgent, { id: "agent_1", agentName: "agent-1", retiredAt, retiredReason: "Obsolete", supersededBy: null });
    mocks.enqueue.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(retireRequest({ reason: "Obsolete" }), params);

    expect(res.status).toBe(500);
    spy.mockRestore();
  });

  it("replays the original result for the same owner request without writing again", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    const tx = mockTransaction(retiredAgent);

    const res = await POST(retireRequest({ reason: "Obsolete" }), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replayed).toBe(true);
    expect(body.retiredReason).toBe("Obsolete");
    expect(body.reconciliationJobId).toBe("job_1");
    expect(tx.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith(tx, { talosId: "agent_1", requestedBy: CREATOR_KEY });
  });

  it("keeps returning 400 for a different request against a retired agent", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    mockTransaction(retiredAgent);

    const res = await POST(retireRequest({ reason: "A different reason" }), params);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("TALOS already retired");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not replay when the signature is invalid", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    mockTransaction(retiredAgent);

    // Signed by a different key than the one claimed.
    const res = await POST(retireRequest({ reason: "Obsolete", signer: other, claimed: CREATOR_KEY }), params);

    expect(res.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not replay for a non-owner, even with a valid signature", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/retire/route");
    mockTransaction(retiredAgent);

    const res = await POST(retireRequest({ reason: "Obsolete", signer: other }), params);

    expect(res.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/talos/:id/retire - reconciliation progress", () => {
  const agent = {
    id: "agent_1",
    status: "Retired",
    agentName: "agent-1",
    creatorPublicKey: CREATOR_KEY,
    walletPublicKey: null,
    agentOnline: false,
    retiredAt,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReset();
    mocks.select.mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
  });

  it("includes remaining steps and the recorded payout snapshot", async () => {
    const { GET } = await import("../src/app/api/talos/[id]/retire/route");
    mocks.findFirst.mockResolvedValueOnce(agent);
    const summary = {
      jobId: "job_1",
      status: "running",
      completedSteps: ["drain-jobs", "payout-obligations"],
      remainingSteps: ["runtime", "services", "credentials"],
      failedStep: null,
      outstandingPayouts: { USDC: "12.500000" },
      completedAt: null,
    };
    mocks.loadSummary.mockResolvedValueOnce(summary);

    const res = await GET(new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + CREATOR_KEY), params);

    expect(res.status).toBe(200);
    expect((await res.json()).reconciliation).toEqual(summary);
  });

  it("still returns the checklist when reconciliation status cannot be loaded", async () => {
    const { GET } = await import("../src/app/api/talos/[id]/retire/route");
    mocks.findFirst.mockResolvedValueOnce(agent);
    mocks.loadSummary.mockRejectedValueOnce(new Error("db down"));

    const res = await GET(new NextRequest("http://localhost:3000/api/talos/agent_1/retire?viewer=" + CREATOR_KEY), params);

    expect(res.status).toBe(200);
    expect((await res.json()).reconciliation).toBeNull();
  });
});
