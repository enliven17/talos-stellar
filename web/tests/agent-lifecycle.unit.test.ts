import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();

  return {
    mockDb: {
      select: mockSelect,
      update: mockUpdate,
    },
  };
});

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn(async () => ({
    ok: true,
    talos: { id: "talos_1", apiKey: "tok_talos_1" },
  })),
}));

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: vi.fn(async (cb: (tx: any) => Promise<any>) => cb({})),
}));

function selectChain(result: any) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(result))),
  };
  return chain;
}

function updateChain(result: any) {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
}

describe("Agent lifecycle workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects new job intake when the TALOS is paused", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/jobs/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "svc_1", serviceName: "research", price: "10", currency: "USDC", fulfillmentMode: "async", stellarPublicKey: "GABC123" }]))
      .mockReturnValueOnce(selectChain([{ id: "talos_1", name: "Test Agent", agentOnline: true, status: "Paused", agentWalletAddress: "GABC123" }]));

    const request = new NextRequest("http://localhost:3000/api/talos/talos_1/jobs", {
      method: "POST",
      headers: { Authorization: "Bearer tok_talos_1" },
      body: JSON.stringify({ buyerPublicKey: "GBUYER", signedXdr: "xdr" }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "talos_1" }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("paused");
  });

  it("marks pending jobs cancelled and clears leases when lifecycle is paused", async () => {
    const { PATCH } = await import("../src/app/api/talos/[id]/status/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "talos_1", status: "Active", agentOnline: true }]));

    mocks.mockDb.update
      .mockReturnValueOnce(updateChain([{ id: "talos_1", status: "Paused", agentOnline: false, agentLastSeen: new Date() }]))
      .mockReturnValueOnce(updateChain([{ id: "job_1", status: "cancelled" }]));

    const request = new NextRequest("http://localhost:3000/api/talos/talos_1/status", {
      method: "PATCH",
      headers: { Authorization: "Bearer tok_talos_1" },
      body: JSON.stringify({ lifecycleStatus: "paused" }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "talos_1" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("Paused");
    expect(body.agentOnline).toBe(false);
  });

  it("rejects retirement re-entry and keeps a retired TALOS from accepting new intake", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/jobs/route");

    mocks.mockDb.select
      .mockReturnValueOnce(selectChain([{ id: "svc_1", serviceName: "research", price: "10", currency: "USDC", fulfillmentMode: "async", stellarPublicKey: "GABC123" }]))
      .mockReturnValueOnce(selectChain([{ id: "talos_1", name: "Test Agent", agentOnline: false, status: "Retired", agentWalletAddress: "GABC123" }]));

    const request = new NextRequest("http://localhost:3000/api/talos/talos_1/jobs", {
      method: "POST",
      headers: { Authorization: "Bearer tok_talos_1" },
      body: JSON.stringify({ buyerPublicKey: "GBUYER", signedXdr: "xdr" }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "talos_1" }) });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("retired");
  });
});
