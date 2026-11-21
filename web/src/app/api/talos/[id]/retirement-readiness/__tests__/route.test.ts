import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const selectMock = vi.fn();
  return { mockDb: { select: selectMock }, selectMock };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

vi.mock("@/lib/tracing", () => ({
  withTraceContext:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fluent select chain that resolves to `result`. */
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

function makeRequest(id: string) {
  return new NextRequest(
    `http://localhost:3000/api/talos/${id}/retirement-readiness`,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/talos/[id]/retirement-readiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with ready=true when agent has no pending obligations", async () => {
    // agent exists, not retired
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_1", retiredAt: null }]))
      // pendingJobs count
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      // pendingPayments count
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      // revenue sum
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      // dividend sum
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_1"), {
      params: Promise.resolve({ id: "talos_1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.blockers).toHaveLength(0);
    expect(body.agentId).toBe("talos_1");
    expect(body.pendingJobs).toBe(0);
    expect(body.pendingPayments).toBe(0);
    expect(body.undistributedRevenueUSDC).toBe(0);
  });

  it("returns 200 with ready=false and blockers when pending jobs exist", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_2", retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 3 }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_2"), {
      params: Promise.resolve({ id: "talos_2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.pendingJobs).toBe(3);
    expect(body.blockers.length).toBeGreaterThan(0);
    expect(body.blockers[0]).toMatch(/3 jobs/i);
  });

  it("returns 200 with ready=false when pending payments exist", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_3", retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_3"), {
      params: Promise.resolve({ id: "talos_3" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.pendingPayments).toBe(1);
  });

  it("returns 200 with ready=false when undistributed revenue exists", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_4", retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      // 100 USDC revenue, 20 USDC distributed → 80 undistributed
      .mockReturnValueOnce(makeSelectChain([{ total: "100.000000" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "20.000000" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_4"), {
      params: Promise.resolve({ id: "talos_4" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.undistributedRevenueUSDC).toBeCloseTo(80, 4);
    expect(body.blockers.some((b: string) => /undistributed/i.test(b))).toBe(true);
  });

  it("returns 200 ready=true when distributed revenue equals total revenue", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_5", retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "50.000000" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "50.000000" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_5"), {
      params: Promise.resolve({ id: "talos_5" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.undistributedRevenueUSDC).toBe(0);
  });

  it("returns 404 when agent does not exist", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("nonexistent"), {
      params: Promise.resolve({ id: "nonexistent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 409 LIFECYCLE_TERMINAL_STATE when agent is already retired", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([{ id: "talos_6", retiredAt: new Date("2025-01-01T00:00:00Z") }]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_6"), {
      params: Promise.resolve({ id: "talos_6" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LIFECYCLE_TERMINAL_STATE");
  });

  it("includes all required report fields in a successful response", async () => {
    mocks.selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: "talos_7", retiredAt: null }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]))
      .mockReturnValueOnce(makeSelectChain([{ total: "0" }]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_7"), {
      params: Promise.resolve({ id: "talos_7" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("agentId");
    expect(body).toHaveProperty("ready");
    expect(body).toHaveProperty("pendingJobs");
    expect(body).toHaveProperty("pendingPayments");
    expect(body).toHaveProperty("undistributedRevenueUSDC");
    expect(body).toHaveProperty("blockers");
    expect(body).toHaveProperty("reportedAt");
    expect(() => new Date(body.reportedAt)).not.toThrow();
  });
});
