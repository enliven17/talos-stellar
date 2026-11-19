import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const selectMock = vi.fn();
  const transactionMock = vi.fn();
  return {
    mockDb: { select: selectMock, transaction: transactionMock },
    selectMock,
    transactionMock,
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

vi.mock("@/lib/tracing", () => ({
  withTraceContext:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((cb: (r: unknown) => unknown) =>
    Promise.resolve(cb(result)),
  );
  return chain;
}

const OWNER = "GABC1234567890123456789012345678901234567890123456789012";
const NEW_OWNER = "GXYZ1234567890123456789012345678901234567890123456789012";
// Make them valid-length Stellar addresses (G + 55 chars)
const VALID_OWNER  = "G" + "A".repeat(55);
const VALID_NEW    = "G" + "B".repeat(55);
const VALID_OTHER  = "G" + "C".repeat(55);

function makeGetRequest(id: string) {
  return new NextRequest(`http://localhost:3000/api/talos/${id}/owner-transfer`);
}

function makePostRequest(id: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3000/api/talos/${id}/owner-transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/talos/[id]/owner-transfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with preview shape for an active agent", async () => {
    mocks.selectMock
      // agent
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_1", creatorPublicKey: VALID_OWNER, retiredAt: null }]))
      // pending jobs
      .mockReturnValueOnce(makeSelectChain([{ count: 2 }]))
      // revenue
      .mockReturnValueOnce(makeSelectChain([{ total: "50.000000" }]))
      // dividends
      .mockReturnValueOnce(makeSelectChain([{ total: "30.000000" }]))
      // patron count
      .mockReturnValueOnce(makeSelectChain([{ count: 5 }]));

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest("talos_1"), {
      params: Promise.resolve({ id: "talos_1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe("talos_1");
    expect(body.currentOwner).toBe(VALID_OWNER);
    expect(Array.isArray(body.affectedPermissions)).toBe(true);
    expect(body.affectedPermissions.length).toBeGreaterThan(0);
    expect(body.pendingObligations.pendingJobs).toBe(2);
    expect(body.pendingObligations.undistributedRevenueUSDC).toBeCloseTo(20, 4);
    expect(body.pendingObligations.activePatronCount).toBe(5);
    expect(typeof body.previewedAt).toBe("string");
  });

  it("returns 404 when agent does not exist", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 409 LIFECYCLE_TERMINAL_STATE for a retired agent", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([{ id: "talos_r", creatorPublicKey: VALID_OWNER, retiredAt: new Date() }]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest("talos_r"), {
      params: Promise.resolve({ id: "talos_r" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LIFECYCLE_TERMINAL_STATE");
  });

  it("returns currentOwner=null when no creator key is set", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_2", creatorPublicKey: null, retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]));

    const { GET } = await import("../route");
    const res = await GET(makeGetRequest("talos_2"), {
      params: Promise.resolve({ id: "talos_2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currentOwner).toBeNull();
  });
});

// ─── POST tests ───────────────────────────────────────────────────────────────

describe("POST /api/talos/[id]/owner-transfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when newOwner is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", { expectedOwner: VALID_OWNER, requestedBy: VALID_OWNER }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when expectedOwner is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", { newOwner: VALID_NEW, requestedBy: VALID_OWNER }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when newOwner equals expectedOwner", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", {
        newOwner: VALID_OWNER,
        expectedOwner: VALID_OWNER,
        requestedBy: VALID_OWNER,
      }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/differ/i);
  });

  it("returns 400 when newOwner is not a valid Stellar address", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", {
        newOwner: "not-stellar",
        expectedOwner: VALID_OWNER,
        requestedBy: VALID_OWNER,
      }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when agent does not exist", async () => {
    mocks.transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue(makeSelectChain([])),
      };
      return fn(fakeTx);
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("missing", {
        newOwner: VALID_NEW,
        expectedOwner: VALID_OWNER,
        requestedBy: VALID_OWNER,
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when requestedBy does not match current owner", async () => {
    mocks.transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue(
          makeSelectChain([{ id: "talos_1", creatorPublicKey: VALID_OWNER, retiredAt: null }]),
        ),
      };
      return fn(fakeTx);
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", {
        newOwner: VALID_NEW,
        expectedOwner: VALID_OWNER,
        requestedBy: VALID_OTHER, // different from current owner
      }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 LIFECYCLE_CONFLICT when expectedOwner no longer matches", async () => {
    mocks.transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue(
          // current owner is now VALID_OTHER, but caller expected VALID_OWNER
          makeSelectChain([{ id: "talos_1", creatorPublicKey: VALID_OTHER, retiredAt: null }]),
        ),
      };
      return fn(fakeTx);
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", {
        newOwner: VALID_NEW,
        expectedOwner: VALID_OWNER, // stale — owner already changed
        requestedBy: VALID_OWNER,
      }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LIFECYCLE_CONFLICT");
  });

  it("returns 200 with transfer details on success", async () => {
    const transferredAt = new Date("2025-06-01T12:00:00.000Z");
    mocks.transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
      let callCount = 0;
      const fakeTx = {
        select: vi.fn().mockReturnValue(
          makeSelectChain([{ id: "talos_1", creatorPublicKey: VALID_OWNER, retiredAt: null }]),
        ),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                { id: "talos_1", creatorPublicKey: VALID_NEW, updatedAt: transferredAt },
              ]),
            }),
          }),
        }),
      };
      return fn(fakeTx);
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest("talos_1", {
        newOwner: VALID_NEW,
        expectedOwner: VALID_OWNER,
        requestedBy: VALID_OWNER,
      }),
      { params: Promise.resolve({ id: "talos_1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe("talos_1");
    expect(body.previousOwner).toBe(VALID_OWNER);
    expect(body.newOwner).toBe(VALID_NEW);
    expect(typeof body.transferredAt).toBe("string");
  });
});
