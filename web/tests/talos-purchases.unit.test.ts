import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.leftJoin = vi.fn(self);
    chain.where = vi.fn(self);
    chain.orderBy = vi.fn(self);
    chain.limit = vi.fn(() => Promise.resolve(result));
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  const verifyAgentApiKey = vi.fn();
  const verifyApiKeyOwnerProof = vi.fn();
  return { dbSelect, makeSelectChain, verifyAgentApiKey, verifyApiKeyOwnerProof };
});

vi.mock("@/db", () => ({
  db: { select: mocks.dbSelect },
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
}));

vi.mock("@/lib/api-key-owner-auth", () => ({
  verifyApiKeyOwnerProof: mocks.verifyApiKeyOwnerProof,
}));

import { GET } from "@/app/api/talos/[id]/purchases/route";

const TALOS = {
  id: "agent-1",
  creatorPublicKey: "GCREATOR",
  walletPublicKey: "GWALLET",
};

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    providerId: "seller-1",
    providerName: "Seller Agent",
    serviceName: "Market Analysis",
    status: "completed",
    price: "12.5",
    txHash: "abc123",
    hasResult: true,
    createdAt: new Date("2026-03-30T10:00:00Z"),
    updatedAt: new Date("2026-03-30T10:05:00Z"),
    ...overrides,
  };
}

function request(url = "http://localhost:3000/api/talos/agent-1/purchases") {
  return new NextRequest(url);
}

function callGet(url?: string) {
  return GET(request(url) as never, {
    params: Promise.resolve({ id: "agent-1" }),
  });
}

describe("GET /api/talos/[id]/purchases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(false);
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: "agent-1" } });
  });

  it("returns 404 when the TALOS does not exist", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([]));

    const res = await callGet();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "TALOS not found" });
  });

  it("returns 403 when the caller is neither the owner nor a key holder", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(false);
    mocks.verifyAgentApiKey.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const res = await callGet();

    expect(res.status).toBe(403);
  });

  it("allows an owner API key and lists purchases", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([makeJob()]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(false);
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: "agent-1" } });

    const res = await callGet();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0]).toMatchObject({
      id: "job-1",
      providerId: "seller-1",
      providerName: "Seller Agent",
      serviceName: "Market Analysis",
      status: "completed",
      price: 12.5,
      hasResult: true,
      resultUrl: "/api/jobs/job-1/result",
      createdAt: "2026-03-30T10:00:00.000Z",
      updatedAt: "2026-03-30T10:05:00.000Z",
    });
    expect(mocks.verifyAgentApiKey).toHaveBeenCalledWith(
      expect.anything(),
      "agent-1",
      ["commerce:read"],
    );
  });

  it("allows a valid wallet proof without an API key", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([makeJob()]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(true);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(mocks.verifyApiKeyOwnerProof).toHaveBeenCalledWith(
      expect.anything(),
      "agent-1",
      "purchases",
    );
    expect(mocks.verifyAgentApiKey).not.toHaveBeenCalled();
  });

  it("returns an empty list with a null cursor when there are no purchases", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(true);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purchases: [], nextCursor: null });
  });

  it("paginates with a cursor when more rows exist", async () => {
    const firstPage = [
      makeJob({ id: "job-1", createdAt: new Date("2026-03-30T10:00:00Z") }),
      makeJob({ id: "job-2", createdAt: new Date("2026-03-30T09:00:00Z") }),
    ];
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain(firstPage));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(true);

    const res = await callGet("http://localhost:3000/api/talos/agent-1/purchases?limit=1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchases).toHaveLength(1);
    expect(body.purchases[0].id).toBe("job-1");
    expect(body.nextCursor).toBe("2026-03-30T10:00:00.000Z");

    // Second page consumes the cursor and terminates.
    const secondPage = [makeJob({ id: "job-2", createdAt: new Date("2026-03-30T09:00:00Z") })];
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain(secondPage));

    const res2 = await callGet(
      "http://localhost:3000/api/talos/agent-1/purchases?limit=1&cursor=2026-03-30T10%3A00%3A00.000Z",
    );

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.purchases[0].id).toBe("job-2");
    expect(body2.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor with 400", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(true);

    const res = await callGet(
      "http://localhost:3000/api/talos/agent-1/purchases?cursor=not-a-date",
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "cursor must be a valid ISO-8601 timestamp",
    });
  });

  it("rejects an invalid limit with 400", async () => {
    mocks.dbSelect.mockImplementationOnce(() => mocks.makeSelectChain([TALOS]));
    mocks.verifyApiKeyOwnerProof.mockResolvedValue(true);

    const res = await callGet("http://localhost:3000/api/talos/agent-1/purchases?limit=abc");

    expect(res.status).toBe(400);
  });
});
