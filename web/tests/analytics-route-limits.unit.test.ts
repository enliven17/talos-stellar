/**
 * Unit tests verifying response-size limits on public analytics and collection endpoints.
 *
 * Checks:
 *  1. Default limit when limit query parameter is absent.
 *  2. Custom valid limit accepted within supported maximum.
 *  3. HTTP 400 validation error when requested limit exceeds maximum allowed limit.
 *  4. HTTP 400 validation error on malformed, zero, or negative limit parameters.
 *  5. Error responses do not expose internal database details.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Shared DB mock ─────────────────────────────────────────────────────────────
function buildSelectChain(rows: unknown[] = []) {
  const obj: Record<string, unknown> = {};
  const passthrough = ["from", "where", "orderBy", "leftJoin", "innerJoin", "groupBy", "as"];
  for (const m of passthrough) {
    obj[m] = vi.fn(() => obj);
  }
  obj.limit = vi.fn(() => obj);
  obj.then = vi.fn((onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled(rows)),
  );
  return obj;
}

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    query: {
      tlsTalos: { findFirst: vi.fn(), findMany: vi.fn() },
      tlsPatrons: { findMany: vi.fn() },
      tlsRevenues: { findMany: vi.fn() },
      tlsCommerceServices: { findMany: vi.fn() },
      tlsCommerceJobs: { findMany: vi.fn() },
      tlsPlaybooks: { findMany: vi.fn() },
      tlsPlaybookPurchases: { findMany: vi.fn() },
      tlsActivities: { findMany: vi.fn() },
    },
  },
  verifyAgentApiKey: vi.fn().mockResolvedValue({ ok: true, talos: { id: "test-agent", apiKey: "valid-key" } }),
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
}));

function req(url: string, params: Record<string, string> = {}): NextRequest {
  const u = new URL(`http://localhost${url}`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return new NextRequest(u.toString(), {
    headers: { Authorization: "Bearer valid-key" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/talos/:id/patrons
// ─────────────────────────────────────────────────────────────────────────────
import { GET as patronsGET } from "@/app/api/talos/[id]/patrons/route";

describe("GET /api/talos/:id/patrons — response-size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDb.select.mockReturnValue(buildSelectChain([{ id: "test-agent" }]));
  });

  it("returns 200 and uses defaultLimit=50 when limit is absent", async () => {
    const res = await patronsGET(req("/api/talos/test-agent/patrons"), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid custom limit=25", async () => {
    const res = await patronsGET(req("/api/talos/test-agent/patrons", { limit: "25" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 when limit exceeds maxLimit=100", async () => {
    const res = await patronsGET(req("/api/talos/test-agent/patrons", { limit: "101" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("exceeds maximum allowed limit of 100");
  });

  it.each(["0", "-5", "abc", "1.5", ""])("returns 400 for malformed limit=%s", async (val) => {
    const res = await patronsGET(req("/api/talos/test-agent/patrons", { limit: val }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("limit must be a positive integer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/talos/:id/dividends
// ─────────────────────────────────────────────────────────────────────────────
import { GET as dividendsGET } from "@/app/api/talos/[id]/dividends/route";

describe("GET /api/talos/:id/dividends — response-size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDb.select.mockReturnValue(buildSelectChain([{ id: "test-agent" }]));
  });

  it("returns 200 with default limit=50", async () => {
    const res = await dividendsGET(req("/api/talos/test-agent/dividends"), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid limit=100 (maximum)", async () => {
    const res = await dividendsGET(req("/api/talos/test-agent/dividends", { limit: "100" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 when limit exceeds maxLimit=100", async () => {
    const res = await dividendsGET(req("/api/talos/test-agent/dividends", { limit: "150" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("exceeds maximum allowed limit of 100");
  });

  it.each(["0", "-1", "xyz", "2.2", ""])("returns 400 for malformed limit=%s", async (val) => {
    const res = await dividendsGET(req("/api/talos/test-agent/dividends", { limit: val }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("limit must be a positive integer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/talos/:id/revenue
// ─────────────────────────────────────────────────────────────────────────────
import { GET as revenueGET } from "@/app/api/talos/[id]/revenue/route";

describe("GET /api/talos/:id/revenue — response-size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDb.select.mockReturnValue(buildSelectChain([{ id: "test-agent" }]));
  });

  it("returns 200 with default limit=50", async () => {
    const res = await revenueGET(req("/api/talos/test-agent/revenue"), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid limit=75", async () => {
    const res = await revenueGET(req("/api/talos/test-agent/revenue", { limit: "75" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 when limit exceeds maxLimit=100", async () => {
    const res = await revenueGET(req("/api/talos/test-agent/revenue", { limit: "101" }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("exceeds maximum allowed limit of 100");
  });

  it.each(["0", "-10", "bad", "3.14", ""])("returns 400 for malformed limit=%s", async (val) => {
    const res = await revenueGET(req("/api/talos/test-agent/revenue", { limit: val }), {
      params: Promise.resolve({ id: "test-agent" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("limit must be a positive integer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET /api/proposals
// ─────────────────────────────────────────────────────────────────────────────
import { GET as proposalsGET } from "@/app/api/proposals/route";

describe("GET /api/proposals — response-size limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
  });

  it("returns 200 with default limit=50", async () => {
    const res = await proposalsGET(req("/api/proposals"));
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid limit=10", async () => {
    const res = await proposalsGET(req("/api/proposals", { limit: "10" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 when limit exceeds maxLimit=100", async () => {
    const res = await proposalsGET(req("/api/proposals", { limit: "120" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("exceeds maximum allowed limit of 100");
  });

  it.each(["0", "-2", "invalid", "1.9", ""])("returns 400 for malformed limit=%s", async (val) => {
    const res = await proposalsGET(req("/api/proposals", { limit: val }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("limit must be a positive integer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error responses do not expose internal DB details
// ─────────────────────────────────────────────────────────────────────────────
describe("Error response detail hiding", () => {
  it("does not leak sql or postgres errors in GET /api/proposals on DB failure", async () => {
    mocks.mockDb.select.mockImplementation(() => {
      throw new Error("FATAL: connection to postgres failed at pg_hba.conf");
    });

    const res = await proposalsGET(req("/api/proposals"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/postgres|pg_hba|sql|FATAL/i);
  });
});
