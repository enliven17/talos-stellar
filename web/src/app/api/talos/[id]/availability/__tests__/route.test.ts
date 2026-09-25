import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const selectMock = vi.fn();
  return {
    mockDb: { select: selectMock },
    selectMock,
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

// Tracing passthrough — just call the wrapped function directly
vi.mock("@/lib/tracing", () => ({
  withTraceContext:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fluent select chain that resolves to `result`. */
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

/** Build a select chain that rejects with a DB error. */
function makeSelectError(message = "Connection timeout") {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation(() => Promise.reject(new Error(message)));
  return chain;
}

function makeRequest(id: string) {
  return new NextRequest(
    `http://localhost:3000/api/talos/${id}/availability`,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/talos/[id]/availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Positive cases ─────────────────────────────────────────────────────────

  it("returns 200 with agentOnline=true and agentLastSeen when the agent is online", async () => {
    const lastSeen = new Date("2026-09-23T20:00:00.000Z");
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_1", agentOnline: true, agentLastSeen: lastSeen, status: "Active" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_1"), {
      params: Promise.resolve({ id: "talos_1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: "talos_1",
      agentOnline: true,
      agentLastSeen: "2026-09-23T20:00:00.000Z",
      status: "Active",
    });
  });

  it("returns 200 with agentOnline=false when the agent is offline", async () => {
    const lastSeen = new Date("2026-09-22T08:30:00.000Z");
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_2", agentOnline: false, agentLastSeen: lastSeen, status: "Active" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_2"), {
      params: Promise.resolve({ id: "talos_2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentOnline).toBe(false);
    expect(body.agentLastSeen).toBe("2026-09-22T08:30:00.000Z");
  });

  it("returns agentLastSeen=null for an agent that has never been seen", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_3", agentOnline: false, agentLastSeen: null, status: "Active" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_3"), {
      params: Promise.resolve({ id: "talos_3" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentLastSeen).toBeNull();
  });

  it("reflects Paused lifecycle status correctly", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_4", agentOnline: false, agentLastSeen: null, status: "Paused" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_4"), {
      params: Promise.resolve({ id: "talos_4" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("Paused");
  });

  it("reflects Retired lifecycle status correctly", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_5", agentOnline: false, agentLastSeen: null, status: "Retired" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_5"), {
      params: Promise.resolve({ id: "talos_5" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("Retired");
    expect(body.agentOnline).toBe(false);
  });

  // ── Not-found case ─────────────────────────────────────────────────────────

  it("returns 404 when the agent does not exist", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectChain([]));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("nonexistent_id"), {
      params: Promise.resolve({ id: "nonexistent_id" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  // ── Dependency-failure case ────────────────────────────────────────────────

  it("returns 503 when the database throws", async () => {
    mocks.selectMock.mockReturnValueOnce(makeSelectError("Connection refused"));

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_1"), {
      params: Promise.resolve({ id: "talos_1" }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/dependency failure|unavailable/i);
  });

  // ── Response shape ─────────────────────────────────────────────────────────

  it("never includes sensitive fields (apiKey, walletPublicKey, etc.)", async () => {
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        {
          id: "talos_6",
          agentOnline: true,
          agentLastSeen: new Date(),
          status: "Active",
          // These should never appear even if somehow joined
          apiKey: "tak_secret",
          walletPublicKey: "GSECRET",
        },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_6"), {
      params: Promise.resolve({ id: "talos_6" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("walletPublicKey");
    // Only expected keys present
    expect(Object.keys(body).sort()).toEqual(
      ["agentLastSeen", "agentOnline", "id", "status"].sort(),
    );
  });

  // ── Boundary: timestamp precision ─────────────────────────────────────────

  it("serialises the timestamp as a valid ISO-8601 string", async () => {
    const lastSeen = new Date("2026-09-23T23:59:59.999Z");
    mocks.selectMock.mockReturnValueOnce(
      makeSelectChain([
        { id: "talos_7", agentOnline: true, agentLastSeen: lastSeen, status: "Active" },
      ]),
    );

    const { GET } = await import("../route");
    const res = await GET(makeRequest("talos_7"), {
      params: Promise.resolve({ id: "talos_7" }),
    });

    const body = await res.json();
    expect(() => new Date(body.agentLastSeen)).not.toThrow();
    expect(new Date(body.agentLastSeen).toISOString()).toBe("2026-09-23T23:59:59.999Z");
  });
});
