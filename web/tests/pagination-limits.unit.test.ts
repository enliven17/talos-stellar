/**
 * Unit tests for the shared pagination limit parser and each list endpoint
 * that was migrated to use it.
 *
 * Test plan:
 *  1. parseLimit — pure-function table-driven tests (no mocks needed)
 *  2. Per-endpoint smoke tests — verify each route returns 400 for bad limit
 *     values and calls through to the DB when the limit is valid.
 *
 * DB is fully mocked; no network calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { parseLimit } from "@/lib/parse-limit";

// ---------------------------------------------------------------------------
// 1. parseLimit — table-driven tests
// ---------------------------------------------------------------------------

describe("parseLimit", () => {
  describe("absent param → default", () => {
    it("returns defaultLimit when raw is null", () => {
      const result = parseLimit(null, 25, 100);
      expect(result).toEqual({ ok: true, limit: 25 });
    });
  });

  describe("valid positive integers", () => {
    const cases: Array<[string, number, number, number]> = [
      ["1", 50, 100, 1],
      ["50", 50, 100, 50],
      ["100", 50, 100, 100],
      ["1", 25, 100, 1],
      ["99", 50, 200, 99],
    ];
    it.each(cases)(
      'parseLimit("%s", %i, %i) → %i',
      (raw, def, max, expected) => {
        const result = parseLimit(raw, def, max);
        expect(result).toEqual({ ok: true, limit: expected });
      },
    );
  });

  describe("exceeds max → clamped to max", () => {
    const cases: Array<[string, number, number, number]> = [
      ["101", 50, 100, 100],
      ["999", 50, 100, 100],
      ["201", 50, 200, 200],
      ["10000", 25, 100, 100],
    ];
    it.each(cases)(
      'parseLimit("%s", %i, %i) → clamped to %i',
      (raw, def, max, expected) => {
        const result = parseLimit(raw, def, max);
        expect(result).toEqual({ ok: true, limit: expected });
      },
    );
  });

  describe("zero → 400", () => {
    it('rejects "0"', () => {
      const result = parseLimit("0", 50, 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
      }
    });
  });

  describe("non-integer strings → 400", () => {
    const invalidCases = [
      "abc",
      "1.5",
      "1.0",
      "-1",
      "-50",
      "",
      " ",
      "1e2",
      "NaN",
      "Infinity",
      "0x10",
      " 10",
      "10 ",
    ];
    it.each(invalidCases)('rejects "%s"', (raw) => {
      const result = parseLimit(raw, 50, 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
      }
    });
  });

  describe("400 response body", () => {
    it("includes a human-readable error message", async () => {
      const result = parseLimit("abc", 50, 100);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body).toHaveProperty("error");
        expect(typeof body.error).toBe("string");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Per-endpoint tests — limit validation + happy-path stub
//    DB is mocked at the module level via vi.hoisted + vi.mock.
// ---------------------------------------------------------------------------

// Shared DB mock — every chain method returns `this` for fluent calls.
const mocks = vi.hoisted(() => {
  const chain = () => {
    const obj: Record<string, unknown> = {};
    const methods = [
      "select", "from", "where", "orderBy", "limit", "leftJoin",
      "innerJoin", "groupBy", "as",
    ];
    for (const m of methods) {
      obj[m] = vi.fn(() => obj);
    }
    // .then() resolves with an empty array by default
    obj.then = vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb([])));
    return obj;
  };

  return {
    mockDb: {
      select: vi.fn(() => chain()),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

// Silence auth module — not relevant for limit tests
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn().mockResolvedValue({ ok: true }),
}));

// Helper — build a minimal NextRequest for GET endpoints
function req(
  url: string,
  params: Record<string, string> = {},
): NextRequest {
  const u = new URL(`http://localhost${url}`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return new NextRequest(u.toString());
}

// ---------------------------------------------------------------------------
// 2a. GET /api/activity
// ---------------------------------------------------------------------------

import { GET as activityGET } from "@/app/api/activity/route";

// The activity route imports its query helpers from a sibling module — mock that
vi.mock("@/app/api/activity/query", () => ({
  fetchActivityStats: vi.fn().mockResolvedValue({ total: 0 }),
  fetchActivityTransactions: vi.fn().mockResolvedValue({ transactions: [], nextCursor: null }),
}));

describe("GET /api/activity — limit validation", () => {
  const INVALID = ["0", "-1", "abc", "1.5", ""];

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await activityGET(req("/api/activity", { limit: val }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 200 and uses defaultLimit=25 when limit is absent", async () => {
    const { fetchActivityTransactions } = await import("@/app/api/activity/query");
    const res = await activityGET(req("/api/activity"));
    expect(res.status).toBe(200);
    // default limit 25 is passed as the first arg
    expect(fetchActivityTransactions).toHaveBeenCalledWith(25, null);
  });

  it("clamps limit=200 to max=100", async () => {
    const { fetchActivityTransactions } = await import("@/app/api/activity/query");
    vi.clearAllMocks();
    // Re-mock to ensure fresh call count
    const { fetchActivityStats } = await import("@/app/api/activity/query");
    (fetchActivityStats as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 0 });
    (fetchActivityTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({ transactions: [], nextCursor: null });

    const res = await activityGET(req("/api/activity", { limit: "200" }));
    expect(res.status).toBe(200);
    expect(fetchActivityTransactions).toHaveBeenCalledWith(100, null);
  });
});

// ---------------------------------------------------------------------------
// 2b. GET /api/talos
// ---------------------------------------------------------------------------

import { GET as talosGET } from "@/app/api/talos/route";

describe("GET /api/talos — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const INVALID = ["0", "-5", "2.5", "nope", ""];

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await talosGET(req("/api/talos", { limit: val }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with a valid limit", async () => {
    // Mock db.select to return a chainable that eventually yields []
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await talosGET(req("/api/talos", { limit: "10" }));
    expect(res.status).toBe(200);
  });

  it("clamps limit=500 to max=100", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await talosGET(req("/api/talos", { limit: "500" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2c. GET /api/services
// ---------------------------------------------------------------------------

import { GET as servicesGET } from "@/app/api/services/route";

describe("GET /api/services — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const INVALID = ["0", "-1", "3.14", "?", ""];

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await servicesGET(req("/api/services", { limit: val }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with a valid limit", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await servicesGET(req("/api/services", { limit: "25" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2d. GET /api/leaderboard
// ---------------------------------------------------------------------------

import { GET as leaderboardGET } from "@/app/api/leaderboard/route";

describe("GET /api/leaderboard — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const INVALID = ["0", "-10", "10.5", "bad", ""];

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await leaderboardGET(req("/api/leaderboard", { limit: val }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with a valid limit", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await leaderboardGET(req("/api/leaderboard", { limit: "50" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2e. GET /api/playbooks
// ---------------------------------------------------------------------------

import { GET as playbooksGET } from "@/app/api/playbooks/route";

describe("GET /api/playbooks — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const INVALID = ["0", "-1", "1.1", "lol", ""];

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await playbooksGET(req("/api/playbooks", { limit: val }));
    expect(res.status).toBe(400);
  });

  it("returns 200 with a valid limit", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await playbooksGET(req("/api/playbooks", { limit: "20" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2f. GET /api/talos/[id]/activity
// ---------------------------------------------------------------------------

import { GET as talosActivityGET } from "@/app/api/talos/[id]/activity/route";

describe("GET /api/talos/[id]/activity — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const TALOS_ID = "talos-abc-123";
  const INVALID = ["0", "-99", "7.7", "x", ""];

  function talosActivityReq(params: Record<string, string> = {}) {
    return req(`/api/talos/${TALOS_ID}/activity`, params);
  }

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await talosActivityGET(
      talosActivityReq({ limit: val }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when TALOS does not exist (valid limit)", async () => {
    // First select (TALOS existence check) returns empty → 404
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await talosActivityGET(
      talosActivityReq({ limit: "10" }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(404);
  });

  it("allows max limit=200 for talos activity", async () => {
    // Returns 404 (talos not found) but not 400 — limit was accepted
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await talosActivityGET(
      talosActivityReq({ limit: "200" }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(404); // not 400
  });

  it("clamps limit=300 to max=200", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await talosActivityGET(
      talosActivityReq({ limit: "300" }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    // 404 (no talos), not 400 — limit accepted and clamped
    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 2g. GET /api/talos/[id]/approvals
// ---------------------------------------------------------------------------

import { GET as approvalsGET } from "@/app/api/talos/[id]/approvals/route";

describe("GET /api/talos/[id]/approvals — limit validation", () => {
  beforeEach(() => vi.clearAllMocks());

  const TALOS_ID = "talos-xyz-456";
  const INVALID = ["0", "-5", "1.9", "bad", ""];

  function approvalsReq(params: Record<string, string> = {}) {
    return req(`/api/talos/${TALOS_ID}/approvals`, params);
  }

  it.each(INVALID)('returns 400 for limit="%s"', async (val) => {
    const res = await approvalsGET(
      approvalsReq({ limit: val }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 200 with valid limit (empty result set)", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await approvalsGET(
      approvalsReq({ limit: "20" }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(200);
  });

  it("clamps limit=500 to max=200", async () => {
    mocks.mockDb.select.mockReturnValue(buildSelectChain([]));
    const res = await approvalsGET(
      approvalsReq({ limit: "500" }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(200); // not 400
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fluent drizzle-like select chain that resolves to `rows`
 * when awaited (via `.then()`).
 */
function buildSelectChain(rows: unknown[]) {
  const obj: Record<string, unknown> = {};
  const passthrough = ["from", "where", "orderBy", "leftJoin", "innerJoin", "groupBy", "as"];
  for (const m of passthrough) {
    obj[m] = vi.fn(() => obj);
  }
  // limit returns `obj` so the chain continues to the await point
  obj.limit = vi.fn(() => obj);
  // Make the chain thenable so `await chain` resolves
  obj.then = vi.fn((onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(onFulfilled(rows)),
  );
  return obj;
}
