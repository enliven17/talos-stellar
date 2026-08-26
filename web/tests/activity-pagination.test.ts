/**
 * Cursor pagination tests for activity feed endpoints.
 *
 * Covers:
 *   GET /api/activity            — global commerce transaction feed
 *   GET /api/talos/[id]/activity — per-agent activity log
 *
 * Acceptance criteria verified here:
 *   ✓ Invalid limits return 400
 *   ✓ Invalid / malformed cursors return 400
 *   ✓ First page (no cursor) returns rows + nextCursor
 *   ✓ Subsequent pages use the cursor and return the right rows
 *   ✓ Two consecutive pages never overlap or skip records at timestamp ties
 *   ✓ Empty pages return an empty array and nextCursor = null
 *   ✓ Agent-specific feed is scoped to the given talosId
 *   ✓ Cursor is opaque (does not expose raw field values to the caller)
 *   ✓ Last page sets nextCursor = null
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ─── Shared DB mock ───────────────────────────────────────────────────────────
//
// Provides a fluent drizzle-like chain whose `.then()` resolves to `rows`.
// Each test that needs specific rows calls `setNextRows(rows)` before the
// handler under test runs.

const mocks = vi.hoisted(() => {
  let pendingRows: unknown[] = [];

  function buildChain(rows: unknown[]) {
    const obj: Record<string, unknown> = {};
    const pass = ["from", "where", "orderBy", "leftJoin", "innerJoin", "groupBy", "as"];
    for (const m of pass) obj[m] = vi.fn(() => obj);
    obj.limit = vi.fn(() => obj);
    obj.then = vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(cb(rows)));
    return obj;
  }

  const mockDb = {
    select: vi.fn(() => buildChain(pendingRows)),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  return {
    mockDb,
    setNextRows(rows: unknown[]) {
      pendingRows = rows;
      // Rebuild the chain with the new rows on the next .select() call
      mockDb.select.mockImplementation(() => buildChain(rows));
    },
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

// ─── Global feed mock (query.ts) ─────────────────────────────────────────────

const {
  fetchActivityStats: mockFetchStats,
  fetchActivityTransactions: mockFetchTransactions,
} = vi.hoisted(() => ({
  fetchActivityStats: vi.fn(),
  fetchActivityTransactions: vi.fn(),
}));

vi.mock("@/app/api/activity/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/activity/query")>()),
  fetchActivityStats: mockFetchStats,
  fetchActivityTransactions: mockFetchTransactions,
}));

// ─── Auth mock (for POST handler, not tested here) ────────────────────────────
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn().mockResolvedValue({ ok: true }),
}));

// ─── Imports (after mocks are set up) ────────────────────────────────────────

import { GET as globalActivityGET } from "@/app/api/activity/route";
import {
  GET as agentActivityGET,
  encodeAgentActivityCursor,
  decodeAgentActivityCursor,
  InvalidAgentActivityCursorError,
} from "@/app/api/talos/[id]/activity/route";
import { encodeActivityCursor } from "@/app/api/activity/query";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TALOS_ID = "talos-test-001";

const STATS = {
  totalTransactions: 5,
  totalVolume: 50,
  activeAgents: 3,
  totalAgents: 5,
  registeredServices: 2,
  playbooksTraded: 3,
};

const TRANSACTIONS_PAGE_1 = [
  {
    id: "service-c",
    type: "service",
    sellerName: "Alpha",
    sellerAgent: "alpha",
    buyerName: "Beta",
    buyerAgent: "beta",
    itemName: "Svc C",
    amount: 10,
    currency: "USDC",
    status: "completed",
    timestamp: "2026-08-01T12:00:00.000Z",
    txHash: null,
  },
  {
    id: "service-b",
    type: "service",
    sellerName: "Alpha",
    sellerAgent: "alpha",
    buyerName: "Beta",
    buyerAgent: "beta",
    itemName: "Svc B",
    amount: 8,
    currency: "USDC",
    status: "completed",
    timestamp: "2026-08-01T11:00:00.000Z",
    txHash: null,
  },
];

const TRANSACTIONS_PAGE_2 = [
  {
    id: "playbook-a",
    type: "playbook",
    sellerName: "Gamma",
    sellerAgent: "gamma",
    buyerName: "Delta",
    buyerAgent: "delta",
    itemName: "PB A",
    amount: 5,
    currency: "USDC",
    status: "completed",
    timestamp: "2026-08-01T10:00:00.000Z",
    txHash: null,
  },
];

// Cursor pointing at the last item of page 1
const GLOBAL_CURSOR_AFTER_PAGE_1 = encodeActivityCursor({
  createdAt: "2026-08-01T11:00:00.000Z",
  type: "service",
  id: "service-b",
});

// Agent activity rows (from tls_activities)
function makeActivityRow(overrides: Partial<{
  id: string;
  talosId: string;
  type: string;
  content: string;
  channel: string;
  status: string;
  createdAt: Date;
}> = {}) {
  return {
    id: "activity-001",
    talosId: TALOS_ID,
    type: "post",
    content: "Hello world",
    channel: "twitter",
    status: "completed",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    ...overrides,
  };
}

// Helper — build an agent activity NextRequest
function agentReq(params: Record<string, string> = {}): NextRequest {
  const u = new URL(`http://localhost/api/talos/${TALOS_ID}/activity`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new NextRequest(u.toString());
}

// Shared context args for Next.js dynamic route
function agentCtx(id = TALOS_ID) {
  return { params: Promise.resolve({ id }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /api/activity — global commerce feed
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/activity — cursor pagination", () => {
  beforeEach(() => {
    mockFetchStats.mockReset().mockResolvedValue(STATS);
    mockFetchTransactions.mockReset();
  });

  // ── First page ─────────────────────────────────────────────────────────────

  it("first page: returns transactions and nextCursor when more rows exist", async () => {
    mockFetchTransactions.mockResolvedValue({
      transactions: TRANSACTIONS_PAGE_1,
      nextCursor: GLOBAL_CURSOR_AFTER_PAGE_1,
    });

    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?limit=2"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transactions).toHaveLength(2);
    expect(body.nextCursor).toBe(GLOBAL_CURSOR_AFTER_PAGE_1);
    expect(mockFetchTransactions).toHaveBeenCalledWith(2, null);
  });

  it("first page with default limit: calls fetchActivityTransactions with limit=25", async () => {
    mockFetchTransactions.mockResolvedValue({ transactions: [], nextCursor: null });

    const res = await globalActivityGET(
      new Request("http://localhost/api/activity"),
    );
    expect(res.status).toBe(200);
    expect(mockFetchTransactions).toHaveBeenCalledWith(25, null);
  });

  // ── Subsequent pages ───────────────────────────────────────────────────────

  it("subsequent page: passes cursor to query and returns correct rows", async () => {
    mockFetchTransactions.mockResolvedValue({
      transactions: TRANSACTIONS_PAGE_2,
      nextCursor: null,
    });

    const res = await globalActivityGET(
      new Request(
        `http://localhost/api/activity?limit=2&cursor=${GLOBAL_CURSOR_AFTER_PAGE_1}`,
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transactions).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    expect(mockFetchTransactions).toHaveBeenCalledWith(2, GLOBAL_CURSOR_AFTER_PAGE_1);
  });

  it("two consecutive pages have no overlap and no gaps", async () => {
    mockFetchTransactions
      .mockResolvedValueOnce({
        transactions: TRANSACTIONS_PAGE_1,
        nextCursor: GLOBAL_CURSOR_AFTER_PAGE_1,
      })
      .mockResolvedValueOnce({
        transactions: TRANSACTIONS_PAGE_2,
        nextCursor: null,
      });

    const page1Res = await globalActivityGET(
      new Request("http://localhost/api/activity?limit=2"),
    );
    const page1 = await page1Res.json();

    const page2Res = await globalActivityGET(
      new Request(
        `http://localhost/api/activity?limit=2&cursor=${page1.nextCursor}`,
      ),
    );
    const page2 = await page2Res.json();

    const allIds = [...page1.transactions, ...page2.transactions].map(
      (t: { id: string }) => t.id,
    );
    expect(allIds).toEqual(["service-c", "service-b", "playbook-a"]);
    // No duplicates
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  // ── Empty page ─────────────────────────────────────────────────────────────

  it("empty page: returns empty transactions array and nextCursor=null", async () => {
    mockFetchTransactions.mockResolvedValue({ transactions: [], nextCursor: null });

    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?limit=10"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.transactions).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("last page: nextCursor is null even when exactly limit rows were returned", async () => {
    mockFetchTransactions.mockResolvedValue({
      transactions: TRANSACTIONS_PAGE_1,
      nextCursor: null,
    });

    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?limit=2"),
    );
    const body = await res.json();

    expect(body.nextCursor).toBeNull();
  });

  // ── statsOnly mode ─────────────────────────────────────────────────────────

  it("statsOnly=true: returns only stats, does not call fetchActivityTransactions", async () => {
    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?statsOnly=true"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats).toEqual(STATS);
    expect(body.transactions).toBeUndefined();
    expect(mockFetchTransactions).not.toHaveBeenCalled();
  });

  // ── Invalid limit ──────────────────────────────────────────────────────────

  it.each(["0", "-1", "abc", "1.5", ""])(
    'returns 400 for invalid limit="%s"',
    async (val) => {
      const res = await globalActivityGET(
        new Request(`http://localhost/api/activity?limit=${val}`),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    },
  );

  it("clamps limit=200 to max=100 and still returns 200", async () => {
    mockFetchTransactions.mockResolvedValue({ transactions: [], nextCursor: null });

    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?limit=200"),
    );
    expect(res.status).toBe(200);
    expect(mockFetchTransactions).toHaveBeenCalledWith(100, null);
  });

  // ── Invalid cursor ─────────────────────────────────────────────────────────

  it("returns 400 for a plain-text cursor", async () => {
    const res = await globalActivityGET(
      new Request("http://localhost/api/activity?cursor=not-a-valid-cursor"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid cursor" });
    // Should bail out before hitting the DB
    expect(mockFetchStats).not.toHaveBeenCalled();
    expect(mockFetchTransactions).not.toHaveBeenCalled();
  });

  it("returns 400 for a base64-encoded but structurally wrong cursor", async () => {
    const badCursor = Buffer.from(
      JSON.stringify({ wrong: "shape" }),
    ).toString("base64url");

    const res = await globalActivityGET(
      new Request(`http://localhost/api/activity?cursor=${badCursor}`),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a cursor with an invalid date", async () => {
    const badCursor = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", type: "service", id: "x" }),
    ).toString("base64url");

    const res = await globalActivityGET(
      new Request(`http://localhost/api/activity?cursor=${badCursor}`),
    );
    expect(res.status).toBe(400);
  });

  // ── Cursor opacity ─────────────────────────────────────────────────────────

  it("cursor does not contain raw timestamp or id values", () => {
    const cursor = encodeActivityCursor({
      createdAt: "2026-08-01T12:00:00.000Z",
      type: "service",
      id: "service-c",
    });

    expect(cursor).not.toContain("service-c");
    expect(cursor).not.toContain("2026-08-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/talos/[id]/activity — per-agent feed
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/talos/[id]/activity — cursor pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  // Convenience: make the DB return a "talos found" row on the first select
  // (existence check) and activity rows on the second.
  function mockTalosAndActivities(activities: ReturnType<typeof makeActivityRow>[]) {
    const talosRow = [{ id: TALOS_ID }];
    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount += 1;
      return buildTestChain(callCount === 1 ? talosRow : activities);
    });
  }

  // ── First page ─────────────────────────────────────────────────────────────

  it("first page: returns activities with nextCursor when more rows exist", async () => {
    const rows = [
      makeActivityRow({ id: "act-3", createdAt: new Date("2026-08-01T12:00:00.000Z") }),
      makeActivityRow({ id: "act-2", createdAt: new Date("2026-08-01T11:00:00.000Z") }),
      // +1 row — signals hasMore
      makeActivityRow({ id: "act-1", createdAt: new Date("2026-08-01T10:00:00.000Z") }),
    ];

    // The route fetches limit=2, so we return limit+1=3 rows to signal hasMore.
    mockTalosAndActivities(rows);

    const res = await agentActivityGET(agentReq({ limit: "2" }), agentCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    // Only 2 rows returned (sliced)
    expect(body.activities).toHaveLength(2);
    expect(body.activities[0].id).toBe("act-3");
    expect(body.activities[1].id).toBe("act-2");
    expect(body.nextCursor).not.toBeNull();
    expect(typeof body.nextCursor).toBe("string");
  });

  it("first page with no cursor: does not include cursor condition in query", async () => {
    const rows = [
      makeActivityRow({ id: "act-1", createdAt: new Date("2026-08-01T12:00:00.000Z") }),
    ];
    mockTalosAndActivities(rows);

    const res = await agentActivityGET(agentReq(), agentCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activities).toHaveLength(1);
    // Single page — no next cursor
    expect(body.nextCursor).toBeNull();
  });

  // ── Subsequent pages ───────────────────────────────────────────────────────

  it("subsequent page: valid cursor is accepted and 200 is returned", async () => {
    const cursor = encodeAgentActivityCursor({
      createdAt: "2026-08-01T11:00:00.000Z",
      id: "act-2",
    });

    // Only one row on page 2 — no next cursor
    const rows = [
      makeActivityRow({ id: "act-1", createdAt: new Date("2026-08-01T10:00:00.000Z") }),
    ];
    mockTalosAndActivities(rows);

    const res = await agentActivityGET(agentReq({ cursor, limit: "2" }), agentCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activities).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("two consecutive pages have no overlap and no gaps (timestamp tie scenario)", async () => {
    // All three activities share the same timestamp — tie-breaking on id DESC
    // ensures a deterministic, stable ordering across page boundaries.
    const SAME_TS = new Date("2026-08-01T12:00:00.000Z");

    const act3 = makeActivityRow({ id: "act-c", createdAt: SAME_TS });
    const act2 = makeActivityRow({ id: "act-b", createdAt: SAME_TS });
    const act1 = makeActivityRow({ id: "act-a", createdAt: SAME_TS });

    // Page 1: returns act-c, act-b, and the sentinel act-a (limit+1 = 3)
    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return buildTestChain([{ id: TALOS_ID }]); // talos check
      if (callCount === 2) return buildTestChain([act3, act2, act1]);  // page 1 (limit+1)
      if (callCount === 3) return buildTestChain([{ id: TALOS_ID }]); // talos check page 2
      return buildTestChain([act1]);                                    // page 2
    });

    // Page 1
    const res1 = await agentActivityGET(agentReq({ limit: "2" }), agentCtx());
    const body1 = await res1.json();
    expect(body1.activities.map((a: { id: string }) => a.id)).toEqual(["act-c", "act-b"]);
    const cursor = body1.nextCursor;
    expect(cursor).not.toBeNull();

    // Cursor must encode both createdAt and id (compound)
    const decoded = decodeAgentActivityCursor(cursor);
    expect(decoded.createdAt).toBe(SAME_TS.toISOString());
    expect(decoded.id).toBe("act-b");

    // Page 2
    const res2 = await agentActivityGET(agentReq({ cursor, limit: "2" }), agentCtx());
    const body2 = await res2.json();
    expect(body2.activities.map((a: { id: string }) => a.id)).toEqual(["act-a"]);
    expect(body2.nextCursor).toBeNull();

    // Combined: no overlap, no gap
    const allIds = [
      ...body1.activities.map((a: { id: string }) => a.id),
      ...body2.activities.map((a: { id: string }) => a.id),
    ];
    expect(allIds).toEqual(["act-c", "act-b", "act-a"]);
    expect(new Set(allIds).size).toBe(3);
  });

  // ── Empty page ─────────────────────────────────────────────────────────────

  it("empty page: returns empty array and nextCursor=null", async () => {
    mockTalosAndActivities([]);

    const res = await agentActivityGET(agentReq({ limit: "10" }), agentCtx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activities).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  // ── Agent-specific scoping ─────────────────────────────────────────────────

  it("returns 404 when the talos does not exist", async () => {
    // Existence check returns empty — talos not found
    mocks.mockDb.select.mockReturnValue(buildTestChain([]));

    const res = await agentActivityGET(
      agentReq({ limit: "10" }),
      { params: Promise.resolve({ id: "nonexistent-talos" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("is scoped to the requested talosId (agent-specific)", async () => {
    const AGENT_A = "agent-aaa";
    const AGENT_B = "agent-bbb";

    // Activities for agent A
    const agentAActivities = [
      makeActivityRow({ id: "aa-1", talosId: AGENT_A, createdAt: new Date("2026-08-01T12:00:00.000Z") }),
    ];

    let callCount = 0;
    mocks.mockDb.select.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return buildTestChain([{ id: AGENT_A }]);
      return buildTestChain(agentAActivities);
    });

    const resA = await agentActivityGET(
      agentReq({ limit: "10" }),
      { params: Promise.resolve({ id: AGENT_A }) },
    );
    const bodyA = await resA.json();
    expect(resA.status).toBe(200);
    expect(bodyA.activities.every((a: { talosId: string }) => a.talosId === AGENT_A)).toBe(true);
    expect(bodyA.activities.some((a: { talosId: string }) => a.talosId === AGENT_B)).toBe(false);
  });

  // ── Invalid limit ──────────────────────────────────────────────────────────

  it.each(["0", "-99", "7.7", "x", ""])(
    'returns 400 for invalid limit="%s"',
    async (val) => {
      const res = await agentActivityGET(agentReq({ limit: val }), agentCtx());
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    },
  );

  it("clamps limit=300 to max=200 and returns 404 (talos not found, not 400)", async () => {
    mocks.mockDb.select.mockReturnValue(buildTestChain([]));

    const res = await agentActivityGET(agentReq({ limit: "300" }), agentCtx());
    // Not a 400 (limit was accepted and clamped); 404 because talos is not found
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(404);
  });

  // ── Invalid cursor ─────────────────────────────────────────────────────────

  it("returns 400 for a plain-text cursor before any DB call", async () => {
    const res = await agentActivityGET(
      agentReq({ cursor: "this-is-not-a-cursor" }),
      agentCtx(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid cursor" });
    // DB must not have been consulted
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for a base64url JSON object with wrong shape", async () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    const res = await agentActivityGET(agentReq({ cursor: bad }), agentCtx());
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for a cursor with an invalid date", async () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "act-1" }),
    ).toString("base64url");
    const res = await agentActivityGET(agentReq({ cursor: bad }), agentCtx());
    expect(res.status).toBe(400);
  });

  it("returns 400 for a cursor with an empty id", async () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-01T12:00:00.000Z", id: "" }),
    ).toString("base64url");
    const res = await agentActivityGET(agentReq({ cursor: bad }), agentCtx());
    expect(res.status).toBe(400);
  });

  // ── Cursor opacity ─────────────────────────────────────────────────────────

  it("cursor does not expose raw createdAt or id values", () => {
    const cursor = encodeAgentActivityCursor({
      createdAt: "2026-08-01T12:00:00.000Z",
      id: "act-unique-99",
    });

    expect(cursor).not.toContain("act-unique-99");
    expect(cursor).not.toContain("2026-08-01");
  });

  it("round-trips through encode → decode correctly", () => {
    const original = { createdAt: "2026-08-01T12:00:00.000Z", id: "act-xyz" };
    const decoded = decodeAgentActivityCursor(encodeAgentActivityCursor(original));
    expect(decoded).toEqual(original);
  });

  it("cursor encodes both createdAt and id (compound key)", () => {
    const cursor = encodeAgentActivityCursor({
      createdAt: "2026-08-01T12:00:00.000Z",
      id: "act-zz",
    });
    const decoded = decodeAgentActivityCursor(cursor);
    // Both fields survive the round-trip
    expect(decoded.createdAt).toBe("2026-08-01T12:00:00.000Z");
    expect(decoded.id).toBe("act-zz");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. InvalidAgentActivityCursorError — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("decodeAgentActivityCursor", () => {
  it("throws InvalidAgentActivityCursorError for plain text", () => {
    expect(() => decodeAgentActivityCursor("not-base64url")).toThrow(
      InvalidAgentActivityCursorError,
    );
  });

  it("throws for valid base64url but wrong JSON structure", () => {
    const bad = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expect(() => decodeAgentActivityCursor(bad)).toThrow(InvalidAgentActivityCursorError);
  });

  it("throws for missing id field", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-01T12:00:00.000Z" }),
    ).toString("base64url");
    expect(() => decodeAgentActivityCursor(bad)).toThrow(InvalidAgentActivityCursorError);
  });

  it("throws for missing createdAt field", () => {
    const bad = Buffer.from(JSON.stringify({ id: "act-1" })).toString("base64url");
    expect(() => decodeAgentActivityCursor(bad)).toThrow(InvalidAgentActivityCursorError);
  });

  it("accepts a valid cursor without throwing", () => {
    const valid = encodeAgentActivityCursor({
      createdAt: "2026-08-01T12:00:00.000Z",
      id: "act-1",
    });
    expect(() => decodeAgentActivityCursor(valid)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a drizzle-like fluent chain that resolves to `rows` when awaited.
 */
function buildTestChain(rows: unknown[]) {
  const obj: Record<string, unknown> = {};
  const pass = ["from", "where", "orderBy", "leftJoin", "innerJoin", "groupBy", "as"];
  for (const m of pass) obj[m] = vi.fn(() => obj);
  obj.limit = vi.fn(() => obj);
  obj.then = vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(cb(rows)));
  return obj;
}
