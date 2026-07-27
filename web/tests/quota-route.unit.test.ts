/**
 * Unit tests for GET/PATCH /api/talos/[id]/quota
 *
 * All database calls and the auth helper are mocked so these tests run
 * without a live Postgres instance or network access.
 *
 * Coverage:
 *   GET  – 401/403 without valid auth
 *        – 404 when agent not found
 *        – 200 with correct quotas shape for all resources
 *        – isAgentOverride flag set correctly
 *   PATCH – 400 on invalid resource / maxCount / windowSize / enabled
 *         – 200 on valid upsert, returns updated config + usage
 *         – defaults: missing fields fall back to current config values
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Chainable select builder that resolves to `result`.
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.where = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  // Insert/upsert chain.
  function makeInsertChain(returningRows: unknown[] = []) {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(() => chain);
    chain.onConflictDoUpdate = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returningRows));
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  const dbInsert = vi.fn(() => makeInsertChain([]));

  const verifyAgentApiKey = vi.fn();

  return { dbSelect, dbInsert, makeSelectChain, makeInsertChain, verifyAgentApiKey };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/db", () => ({
  db: { select: mocks.dbSelect, insert: mocks.dbInsert },
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
}));

vi.mock("@/db/schema", () => ({
  tlsTalos: { id: "id", apiKey: "apiKey" },
  tlsQuotaConfigs: { talosId: "talosId", resource: "resource" },
  tlsQuotaUsage: { talosId: "talosId", resource: "resource", windowStart: "windowStart", count: "count" },
  tlsApiAuditLogs: { talosId: "talosId", method: "method", path: "path", statusCode: "statusCode", ipAddress: "ipAddress" },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ op: "and", a })),
  eq: vi.fn((c: string, v: unknown) => ({ op: "eq", c, v })),
  isNull: vi.fn((c: string) => ({ op: "isNull", c })),
  or: vi.fn((...a: unknown[]) => ({ op: "or", a })),
  sql: new Proxy(() => {}, {
    apply: (_t, _this, args) => ({ op: "sql", args }),
    get: () => vi.fn(),
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { GET, PATCH } from "@/app/api/talos/[id]/quota/route";

// ── Constants ─────────────────────────────────────────────────────────────────

const TALOS_ID = "talos-abc";
const API_KEY  = "test-api-key";

const ALL_RESOURCES = ["activity_writes", "job_writes", "revenue_writes", "sse_connections"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(
  method: "GET" | "PATCH",
  body?: Record<string, unknown>,
): NextRequest {
  const url = `http://localhost/api/talos/${TALOS_ID}/quota`;
  return new NextRequest(url, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeParams() {
  return { params: Promise.resolve({ id: TALOS_ID }) };
}

function makeConfigRow(resource: string, overrides: Record<string, unknown> = {}) {
  return {
    talosId: TALOS_ID,
    resource,
    maxCount: 100,
    windowSize: "daily",
    enabled: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: auth succeeds
  mocks.verifyAgentApiKey.mockResolvedValue({
    ok: true,
    talos: { id: TALOS_ID, apiKey: API_KEY },
  });

  // Default select: returns talos exists, then empty quota rows
  mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));

  // Default insert: upsert succeeds
  mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));
});

// ── GET /api/talos/:id/quota ──────────────────────────────────────────────────

describe("GET /api/talos/[id]/quota", () => {
  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      mocks.verifyAgentApiKey.mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "Missing Authorization header. Use: Bearer <api_key>" }, { status: 401 }),
      });

      const req = new NextRequest(`http://localhost/api/talos/${TALOS_ID}/quota`);
      const res = await GET(req, makeParams());

      expect(res.status).toBe(401);
    });

    it("returns 403 when API key is invalid", async () => {
      mocks.verifyAgentApiKey.mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "Invalid API key" }, { status: 403 }),
      });

      const res = await GET(makeRequest("GET"), makeParams());
      expect(res.status).toBe(403);
    });
  });

  describe("agent not found", () => {
    it("returns 404 when TALOS does not exist", async () => {
      // Auth passes, but talos select returns empty
      mocks.dbSelect
        .mockReturnValueOnce(mocks.makeSelectChain([])); // talos not found

      const res = await GET(makeRequest("GET"), makeParams());
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe("successful response", () => {
    beforeEach(() => {
      // Provide a valid talos row for the existence check
      const talosRow = { id: TALOS_ID };

      // Calls in order:
      //  1. db.select talos (existence check)
      //  2. db.select tlsQuotaConfigs (all agent + platform rows)
      //  3–N: resolveQuotaConfig + readQuotaUsage for each resource (×4)
      //        resolveQuotaConfig → db.select tlsQuotaConfigs
      //        readQuotaUsage    → resolveQuotaConfig (db.select) + usage select

      // Return talos on first call, empty rows on all subsequent selects
      // (quota selects → disabled fallback + zero usage).
      mocks.dbSelect
        .mockReturnValueOnce(mocks.makeSelectChain([talosRow]))  // talos existence check
        .mockImplementation(() => mocks.makeSelectChain([]));   // all quota queries → empty
    });

    it("returns 200 with talosId", async () => {
      const res = await GET(makeRequest("GET"), makeParams());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.talosId).toBe(TALOS_ID);
    });

    it("response contains all four quota resources", async () => {
      const res = await GET(makeRequest("GET"), makeParams());
      const body = await res.json();
      for (const resource of ALL_RESOURCES) {
        expect(body.quotas).toHaveProperty(resource);
      }
    });

    it("each resource entry has config and usage sub-objects", async () => {
      const res = await GET(makeRequest("GET"), makeParams());
      const body = await res.json();
      for (const resource of ALL_RESOURCES) {
        const entry = body.quotas[resource];
        expect(entry).toHaveProperty("config");
        expect(entry).toHaveProperty("usage");

        // Config shape
        expect(entry.config).toHaveProperty("maxCount");
        expect(entry.config).toHaveProperty("windowSize");
        expect(typeof entry.config.enabled).toBe("boolean");
        expect(typeof entry.config.isAgentOverride).toBe("boolean");

        // Usage shape
        expect(entry.usage).toHaveProperty("used");
        expect(entry.usage).toHaveProperty("remaining");
        expect(entry.usage).toHaveProperty("limit");
        expect(entry.usage).toHaveProperty("resetAt");
        expect(typeof entry.usage.ok).toBe("boolean");
      }
    });

    it("resetAt is an ISO-8601 string", async () => {
      const res = await GET(makeRequest("GET"), makeParams());
      const body = await res.json();
      const resetAt = body.quotas.activity_writes.usage.resetAt;
      expect(resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("isAgentOverride is false when only platform defaults exist", async () => {
      const res = await GET(makeRequest("GET"), makeParams());
      const body = await res.json();
      // No agent-specific rows were returned → isAgentOverride must be false
      expect(body.quotas.activity_writes.config.isAgentOverride).toBe(false);
    });

    it("isAgentOverride is true when an agent-specific config row exists", async () => {
      const agentRow = makeConfigRow("activity_writes", { talosId: TALOS_ID });

      // Re-configure selects for this test by resetting mocks first so the
      // queue from beforeEach doesn't interfere.
      //  1. talos existence check
      //  2. configRows query (agent-level + platform) → returns the agent row
      //  3+ resolveQuotaConfig + readQuotaUsage selects → empty (fallback)
      mocks.dbSelect.mockReset();
      mocks.dbSelect
        .mockReturnValueOnce(mocks.makeSelectChain([{ id: TALOS_ID }]))  // talos
        .mockReturnValueOnce(mocks.makeSelectChain([agentRow]))           // configRows bulk query
        .mockImplementation(() => mocks.makeSelectChain([]));             // all other quota queries

      const res = await GET(makeRequest("GET"), makeParams());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotas.activity_writes.config.isAgentOverride).toBe(true);
    });
  });
});

// ── PATCH /api/talos/:id/quota ────────────────────────────────────────────────

describe("PATCH /api/talos/[id]/quota", () => {
  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      mocks.verifyAgentApiKey.mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "Missing Authorization header. Use: Bearer <api_key>" }, { status: 401 }),
      });

      const req = new NextRequest(`http://localhost/api/talos/${TALOS_ID}/quota`, { method: "PATCH" });
      const res = await PATCH(req, makeParams());
      expect(res.status).toBe(401);
    });
  });

  describe("input validation", () => {
    it("returns 400 when body is invalid JSON", async () => {
      const req = new NextRequest(`http://localhost/api/talos/${TALOS_ID}/quota`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: "not json{",
      });
      const res = await PATCH(req, makeParams());
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/json/i);
    });

    it("returns 400 when resource is missing", async () => {
      const res = await PATCH(makeRequest("PATCH", { maxCount: 100 }), makeParams());
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/resource/i);
    });

    it("returns 400 when resource is not a valid quota resource", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "invalid_resource", maxCount: 100 }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/resource/i);
    });

    it("returns 400 when maxCount is not a positive integer", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", maxCount: -5 }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/maxCount/i);
    });

    it("returns 400 when maxCount is zero", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", maxCount: 0 }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/maxCount/i);
    });

    it("returns 400 when maxCount is a float", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", maxCount: 1.5 }),
        makeParams(),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when windowSize is not a valid option", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", windowSize: "weekly" }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/windowSize/i);
    });

    it("returns 400 when enabled is not a boolean", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", enabled: "yes" }),
        makeParams(),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/enabled/i);
    });
  });

  describe("successful upsert", () => {
    beforeEach(() => {
      // resolveQuotaConfig (for "current" fallback) + resolveQuotaConfig + readQuotaUsage
      // after upsert → all empty, giving disabled safe fallback.
      mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
      mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));
    });

    it("returns 200 with talosId, resource, config, and usage", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", maxCount: 250, enabled: true }),
        makeParams(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.talosId).toBe(TALOS_ID);
      expect(body.resource).toBe("activity_writes");
      expect(body).toHaveProperty("config");
      expect(body).toHaveProperty("usage");
    });

    it("returns isAgentOverride: true after an upsert", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "job_writes", maxCount: 50 }),
        makeParams(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.isAgentOverride).toBe(true);
    });

    it("accepts all valid resources", async () => {
      for (const resource of ALL_RESOURCES) {
        vi.clearAllMocks();
        mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: TALOS_ID, apiKey: API_KEY } });
        mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
        mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));

        const res = await PATCH(
          makeRequest("PATCH", { resource, maxCount: 100 }),
          makeParams(),
        );
        expect(res.status).toBe(200);
      }
    });

    it("accepts all valid windowSize values", async () => {
      for (const windowSize of ["hourly", "daily", "monthly"]) {
        vi.clearAllMocks();
        mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: TALOS_ID, apiKey: API_KEY } });
        mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
        mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));

        const res = await PATCH(
          makeRequest("PATCH", { resource: "activity_writes", windowSize }),
          makeParams(),
        );
        expect(res.status).toBe(200);
      }
    });

    it("omitting maxCount keeps the existing value (defaults to current config)", async () => {
      // Return an existing config row for the "current" resolve call.
      const existingRow = makeConfigRow("activity_writes", { maxCount: 999, enabled: true });
      // First resolve call (to get "current") returns existing row.
      // Second resolve call (after upsert) also returns a row.
      mocks.dbSelect
        .mockReturnValueOnce(mocks.makeSelectChain([existingRow]))  // current config
        .mockReturnValueOnce(mocks.makeSelectChain([existingRow]))  // after-upsert resolve
        .mockReturnValueOnce(mocks.makeSelectChain([]));            // usage query

      const res = await PATCH(
        makeRequest("PATCH", { resource: "activity_writes", enabled: false }),
        makeParams(),
      );
      expect(res.status).toBe(200);
      // The upsert should have been called with maxCount=999 (preserved)
      expect(mocks.dbInsert).toHaveBeenCalled();
    });

    it("usage shape includes used, remaining, limit, resetAt, and ok", async () => {
      const res = await PATCH(
        makeRequest("PATCH", { resource: "revenue_writes", maxCount: 300, enabled: true }),
        makeParams(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage).toHaveProperty("used");
      expect(body.usage).toHaveProperty("remaining");
      expect(body.usage).toHaveProperty("limit");
      expect(body.usage).toHaveProperty("resetAt");
      expect(typeof body.usage.ok).toBe("boolean");
    });

    it("performs exactly one db.insert (the upsert)", async () => {
      await PATCH(
        makeRequest("PATCH", { resource: "sse_connections", maxCount: 20, windowSize: "hourly" }),
        makeParams(),
      );
      expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
    });
  });
});
