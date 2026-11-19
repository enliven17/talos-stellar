/**
 * Unit tests for src/lib/quota.ts
 *
 * All database calls are mocked so these tests run without a Postgres
 * instance.  The tests cover:
 *
 *   – floorToWindow / nextWindowStart helpers
 *   – resolveQuotaConfig precedence (agent > platform > fallback)
 *   – checkAndIncrementQuota: disabled, under limit, at limit, over limit
 *   – readQuotaUsage: existing row, no row
 *   – quotaExceededResponse: status code, headers, body
 *   – buildQuotaHeaders / applyQuotaHeaders: header values
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  // Build a chainable Drizzle-style query mock that resolves to `result`.
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

  // Insert chain for the upsert in checkAndIncrementQuota.
  function makeInsertChain(returningRows: unknown[] = []) {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn(() => chain);
    chain.onConflictDoUpdate = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returningRows));
    return chain;
  }

  const dbSelect = vi.fn(() => makeSelectChain([]));
  const dbInsert = vi.fn(() => makeInsertChain([]));

  return { dbSelect, dbInsert, makeSelectChain, makeInsertChain };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@/db/schema", () => ({
  tlsQuotaConfigs: { talosId: "talosId", resource: "resource" },
  tlsQuotaUsage: {
    talosId: "talosId",
    resource: "resource",
    windowStart: "windowStart",
    count: "count",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((col: string, val: unknown) => ({ op: "eq", col, val })),
  isNull: vi.fn((col: string) => ({ op: "isNull", col })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  sql: new Proxy(() => {}, {
    apply: (_t, _this, args) => ({ op: "sql", args }),
    get: (_t, p) => p === "raw" ? vi.fn() : undefined,
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  floorToWindow,
  nextWindowStart,
  resolveQuotaConfig,
  checkAndIncrementQuota,
  readQuotaUsage,
  quotaExceededResponse,
  buildQuotaHeaders,
  buildQuotaExplanation,
  applyQuotaHeaders,
  type QuotaResource,
  type WindowSize,
} from "@/lib/quota";

// ── Fake DB ───────────────────────────────────────────────────────────────────

const fakeDb = {
  select: mocks.dbSelect,
  insert: mocks.dbInsert,
} as unknown as Parameters<typeof checkAndIncrementQuota>[0];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQuotaConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    talosId: "agent-1",
    resource: "activity_writes",
    maxCount: 100,
    windowSize: "daily",
    enabled: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbSelect.mockImplementation(() => mocks.makeSelectChain([]));
  mocks.dbInsert.mockImplementation(() => mocks.makeInsertChain([{ count: 1 }]));
});

// ─── floorToWindow ────────────────────────────────────────────────────────────

describe("floorToWindow", () => {
  const base = new Date("2026-07-24T14:37:45.000Z");

  it("floors to the UTC hour for 'hourly'", () => {
    const result = floorToWindow(base, "hourly");
    expect(result.toISOString()).toBe("2026-07-24T14:00:00.000Z");
  });

  it("floors to UTC midnight for 'daily'", () => {
    const result = floorToWindow(base, "daily");
    expect(result.toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });

  it("floors to the first of the UTC month for 'monthly'", () => {
    const result = floorToWindow(base, "monthly");
    expect(result.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not mutate the input Date", () => {
    const input = new Date("2026-07-24T14:37:45.000Z");
    floorToWindow(input, "daily");
    expect(input.toISOString()).toBe("2026-07-24T14:37:45.000Z");
  });
});

// ─── nextWindowStart ──────────────────────────────────────────────────────────

describe("nextWindowStart", () => {
  it("adds one hour for 'hourly'", () => {
    const start = new Date("2026-07-24T14:00:00.000Z");
    const next = nextWindowStart(start, "hourly");
    expect(next.toISOString()).toBe("2026-07-24T15:00:00.000Z");
  });

  it("adds one day for 'daily'", () => {
    const start = new Date("2026-07-24T00:00:00.000Z");
    const next = nextWindowStart(start, "daily");
    expect(next.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("adds one month for 'monthly'", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    const next = nextWindowStart(start, "monthly");
    expect(next.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("handles month-end correctly (July 31 → August 31)", () => {
    const start = new Date("2026-07-31T00:00:00.000Z");
    const next = nextWindowStart(start, "daily");
    expect(next.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("does not mutate the input Date", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    nextWindowStart(start, "monthly");
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

// ─── resolveQuotaConfig ───────────────────────────────────────────────────────

describe("resolveQuotaConfig", () => {
  it("returns agent-specific row when present (takes priority over platform default)", async () => {
    const agentRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 50 });
    const platformRow = makeQuotaConfigRow({ talosId: null, maxCount: 500 });

    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([agentRow, platformRow]));

    const config = await resolveQuotaConfig(fakeDb, "agent-1", "activity_writes");

    expect(config.talosId).toBe("agent-1");
    expect(config.maxCount).toBe(50);
    expect(config.enabled).toBe(true);
  });

  it("falls back to platform default when no agent row exists", async () => {
    const platformRow = makeQuotaConfigRow({ talosId: null, maxCount: 500 });

    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([platformRow]));

    const config = await resolveQuotaConfig(fakeDb, "agent-1", "activity_writes");

    expect(config.talosId).toBeNull();
    expect(config.maxCount).toBe(500);
  });

  it("returns hard-coded disabled fallback when no DB rows match", async () => {
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([]));

    const config = await resolveQuotaConfig(fakeDb, "agent-1", "activity_writes");

    expect(config.enabled).toBe(false);
    expect(config.maxCount).toBe(10_000);
    expect(config.talosId).toBeNull();
    expect(config.notes).toMatch(/disabled/i);
  });

  it("maps windowSize and resource correctly from the DB row", async () => {
    const row = makeQuotaConfigRow({
      talosId: "agent-2",
      resource: "sse_connections",
      windowSize: "hourly",
      maxCount: 30,
      enabled: false,
    });

    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([row]));

    const config = await resolveQuotaConfig(fakeDb, "agent-2", "sse_connections");

    expect(config.resource).toBe("sse_connections");
    expect(config.windowSize).toBe("hourly");
    expect(config.maxCount).toBe(30);
    expect(config.enabled).toBe(false);
  });
});

// ─── checkAndIncrementQuota ───────────────────────────────────────────────────

describe("checkAndIncrementQuota", () => {
  it("returns ok:true immediately when quota is disabled — no insert performed", async () => {
    // Empty config rows → disabled fallback
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([]));

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(true);
    expect(result.used).toBe(0);
    expect(result.resource).toBe("activity_writes");
    // No DB insert when quota is disabled
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("returns ok:true when usage is under the limit", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 100, enabled: true, windowSize: "daily" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
    // Upsert returns count=10
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 10 }]));

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(true);
    expect(result.used).toBe(10);
    expect(result.remaining).toBe(90);
    expect(result.limit).toBe(100);
    expect(result.windowSize).toBe("daily");
    expect(result.policy).toBe("agent");
    expect(result.explanation).toContain("Used 10 of 100");
    expect(result.explanation).toContain("agent daily quota");
  });

  it("returns ok:true when usage equals the limit (last allowed slot)", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 5, enabled: true, windowSize: "hourly" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 5 }]));

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(true);
    expect(result.used).toBe(5);
    expect(result.remaining).toBe(0);
    expect(result.windowSize).toBe("hourly");
    expect(result.policy).toBe("agent");
    expect(result.explanation).toContain("Used 5 of 5");
  });

  it("returns ok:false when usage exceeds the limit", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 5, enabled: true, windowSize: "monthly" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
    // Counter already at 6 (exceeded by 1)
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 6 }]));

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.ok).toBe(false);
    expect(result.used).toBe(6);
    expect(result.remaining).toBe(0);
    expect(result.windowSize).toBe("monthly");
    expect(result.policy).toBe("agent");
    expect(result.explanation).toContain("Quota exceeded");
    expect(result.explanation).toContain("agent monthly quota");
  });

  it("returns platform policy when no agent-specific config exists", async () => {
    const platformRow = makeQuotaConfigRow({ talosId: null, maxCount: 200, enabled: true, windowSize: "daily" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([platformRow]));
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 1 }]));

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(result.policy).toBe("platform");
    expect(result.explanation).toContain("platform daily quota");
  });

  it("returns correct resource in result", async () => {
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([])); // disabled fallback

    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "job_writes");

    expect(result.resource).toBe("job_writes");
  });

  it("includes a resetAt timestamp in the future", async () => {
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([])); // disabled

    const before = Date.now();
    const result = await checkAndIncrementQuota(fakeDb, "agent-1", "revenue_writes");
    const after = Date.now() + 24 * 60 * 60 * 1000; // upper bound: ~1 day ahead

    expect(result.resetAt).toBeGreaterThanOrEqual(before);
    expect(result.resetAt).toBeLessThanOrEqual(after);
  });

  it("performs an upsert when quota is enabled", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 100, enabled: true });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
    mocks.dbInsert.mockReturnValueOnce(mocks.makeInsertChain([{ count: 1 }]));

    await checkAndIncrementQuota(fakeDb, "agent-1", "activity_writes");

    expect(mocks.dbInsert).toHaveBeenCalledTimes(1);
  });
});

// ─── readQuotaUsage ───────────────────────────────────────────────────────────

describe("readQuotaUsage", () => {
  it("returns used=0 when no usage row exists for the current window", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 100, enabled: true });
    // First select: resolveQuotaConfig
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));
    // Second select: usage row — not found
    const usageChain = mocks.makeSelectChain([]);
    // readQuotaUsage chains .select().from().where().limit().then()
    usageChain.from = vi.fn(() => usageChain);
    usageChain.where = vi.fn(() => usageChain);
    usageChain.limit = vi.fn(() => usageChain);
    usageChain.then = vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve([]).then(cb));
    mocks.dbSelect.mockReturnValueOnce(usageChain);

    const result = await readQuotaUsage(fakeDb, "agent-1", "activity_writes");

    expect(result.used).toBe(0);
    expect(result.remaining).toBe(100);
    expect(result.ok).toBe(true);
    // readQuotaUsage must NOT call db.insert
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it("returns the current count when a usage row exists", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 100, enabled: true, windowSize: "daily" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));

    const usageChain = mocks.makeSelectChain([]);
    usageChain.from = vi.fn(() => usageChain);
    usageChain.where = vi.fn(() => usageChain);
    usageChain.limit = vi.fn(() => usageChain);
    usageChain.then = vi.fn((cb: (v: unknown[]) => unknown) =>
      Promise.resolve([{ count: 42 }]).then(cb),
    );
    mocks.dbSelect.mockReturnValueOnce(usageChain);

    const result = await readQuotaUsage(fakeDb, "agent-1", "activity_writes");

    expect(result.used).toBe(42);
    expect(result.remaining).toBe(58);
    expect(result.ok).toBe(true);
    expect(result.windowSize).toBe("daily");
    expect(result.policy).toBe("agent");
    expect(result.explanation).toContain("Used 42 of 100");
    expect(result.explanation).toContain("agent daily quota");
  });

  it("reports ok:false when usage exceeds the limit", async () => {
    const configRow = makeQuotaConfigRow({ talosId: "agent-1", maxCount: 10, enabled: true, windowSize: "hourly" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([configRow]));

    const usageChain = mocks.makeSelectChain([]);
    usageChain.from = vi.fn(() => usageChain);
    usageChain.where = vi.fn(() => usageChain);
    usageChain.limit = vi.fn(() => usageChain);
    usageChain.then = vi.fn((cb: (v: unknown[]) => unknown) =>
      Promise.resolve([{ count: 15 }]).then(cb),
    );
    mocks.dbSelect.mockReturnValueOnce(usageChain);

    const result = await readQuotaUsage(fakeDb, "agent-1", "activity_writes");

    expect(result.used).toBe(15);
    expect(result.remaining).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.windowSize).toBe("hourly");
    expect(result.policy).toBe("agent");
    expect(result.explanation).toContain("Quota exceeded");
    expect(result.explanation).toContain("agent hourly quota");
  });

  it("returns platform policy when no agent-specific config exists", async () => {
    const platformRow = makeQuotaConfigRow({ talosId: null, maxCount: 200, enabled: true, windowSize: "monthly" });
    mocks.dbSelect.mockReturnValueOnce(mocks.makeSelectChain([platformRow]));

    const usageChain = mocks.makeSelectChain([]);
    usageChain.from = vi.fn(() => usageChain);
    usageChain.where = vi.fn(() => usageChain);
    usageChain.limit = vi.fn(() => usageChain);
    usageChain.then = vi.fn((cb: (v: unknown[]) => unknown) =>
      Promise.resolve([{ count: 5 }]).then(cb),
    );
    mocks.dbSelect.mockReturnValueOnce(usageChain);

    const result = await readQuotaUsage(fakeDb, "agent-1", "activity_writes");

    expect(result.policy).toBe("platform");
    expect(result.explanation).toContain("platform monthly quota");
  });
});

// ─── quotaExceededResponse ────────────────────────────────────────────────────

describe("quotaExceededResponse", () => {
  const exceeded = {
    ok: false,
    limit: 100,
    remaining: 0,
    used: 101,
    resetAt: new Date("2026-07-25T00:00:00.000Z").getTime(),
    resource: "activity_writes" as QuotaResource,
    windowSize: "daily" as WindowSize,
    policy: "agent" as const,
    explanation: "Quota exceeded: used 101 of 100 (agent daily quota). Resets at 2026-07-25T00:00:00.000Z.",
  };

  it("returns HTTP 429", () => {
    const resp = quotaExceededResponse(exceeded);
    expect(resp.status).toBe(429);
  });

  it("includes X-Quota-* headers", () => {
    const resp = quotaExceededResponse(exceeded);
    expect(resp.headers.get("X-Quota-Limit")).toBe("100");
    expect(resp.headers.get("X-Quota-Remaining")).toBe("0");
    expect(resp.headers.get("X-Quota-Used")).toBe("101");
    expect(resp.headers.get("X-Quota-Resource")).toBe("activity_writes");
    expect(resp.headers.get("X-Quota-Reset")).toBeTruthy();
  });

  it("body contains error, resource, limit, and resetAt", async () => {
    const resp = quotaExceededResponse(exceeded);
    const body = await resp.json();
    expect(body.error).toBe("Quota exceeded");
    expect(body.resource).toBe("activity_writes");
    expect(body.limit).toBe(100);
    expect(body.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
  });

  it("Content-Type is application/json", () => {
    const resp = quotaExceededResponse(exceeded);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
  });
});

// ─── buildQuotaHeaders ────────────────────────────────────────────────────────

describe("buildQuotaHeaders", () => {
  const result = {
    ok: true,
    limit: 500,
    remaining: 490,
    used: 10,
    resetAt: 1_753_401_600_000,
    resource: "job_writes" as QuotaResource,
    windowSize: "monthly" as WindowSize,
    policy: "platform" as const,
    explanation: "test",
  };

  it("returns all five quota header keys", () => {
    const headers = buildQuotaHeaders(result);
    expect(headers["X-Quota-Limit"]).toBe("500");
    expect(headers["X-Quota-Remaining"]).toBe("490");
    expect(headers["X-Quota-Used"]).toBe("10");
    expect(headers["X-Quota-Resource"]).toBe("job_writes");
    expect(headers["X-Quota-Reset"]).toBeDefined();
  });

  it("X-Quota-Reset is in seconds (Unix epoch), not milliseconds", () => {
    const headers = buildQuotaHeaders(result);
    // resetAt is 1_753_401_600_000 ms → 1_753_401_600 s
    expect(headers["X-Quota-Reset"]).toBe(String(Math.ceil(1_753_401_600_000 / 1000)));
  });
});

// ─── applyQuotaHeaders ────────────────────────────────────────────────────────

describe("applyQuotaHeaders", () => {
  it("sets all quota headers on the response object", () => {
    const result = {
      ok: true,
      limit: 200,
      remaining: 150,
      used: 50,
      resetAt: Date.now() + 3600_000,
      resource: "revenue_writes" as QuotaResource,
      windowSize: "daily" as WindowSize,
      policy: "platform" as const,
      explanation: "test",
    };

    const resp = new Response(JSON.stringify({ id: "x" }), { status: 201 });
    const patched = applyQuotaHeaders(resp, result);

    expect(patched.headers.get("X-Quota-Limit")).toBe("200");
    expect(patched.headers.get("X-Quota-Remaining")).toBe("150");
    expect(patched.headers.get("X-Quota-Used")).toBe("50");
    expect(patched.headers.get("X-Quota-Resource")).toBe("revenue_writes");
  });

  it("preserves existing response status", () => {
    const result = {
      ok: true,
      limit: 50,
      remaining: 49,
      used: 1,
      resetAt: Date.now() + 3600_000,
      resource: "sse_connections" as QuotaResource,
      windowSize: "hourly" as WindowSize,
      policy: "agent" as const,
      explanation: "test",
    };

    const resp = new Response(null, { status: 201 });
    const patched = applyQuotaHeaders(resp, result);
    expect(patched.status).toBe(201);
  });
});

// ─── buildQuotaHeaders — new headers ────────────────────────────────────────

describe("buildQuotaHeaders — includes windowSize and policy", () => {
  const result = {
    ok: true,
    limit: 500,
    remaining: 490,
    used: 10,
    resetAt: 1_753_401_600_000,
    resource: "job_writes" as QuotaResource,
    windowSize: "monthly" as WindowSize,
    policy: "agent" as const,
    explanation: "test",
  };

  it("includes X-Quota-Window header", () => {
    const headers = buildQuotaHeaders(result);
    expect(headers["X-Quota-Window"]).toBe("monthly");
  });

  it("includes X-Quota-Policy header", () => {
    const headers = buildQuotaHeaders(result);
    expect(headers["X-Quota-Policy"]).toBe("agent");
  });
});

// ─── buildQuotaExplanation ───────────────────────────────────────────────────

describe("buildQuotaExplanation", () => {
  it("returns all fields with ISO-8601 resetAt", () => {
    const result = {
      ok: true,
      limit: 100,
      remaining: 95,
      used: 5,
      resetAt: new Date("2026-07-25T00:00:00.000Z").getTime(),
      resource: "activity_writes" as QuotaResource,
      windowSize: "daily" as WindowSize,
      policy: "platform" as const,
      explanation: "Used 5 of 100 (platform daily quota). 95 remaining.",
    };

    const explanation = buildQuotaExplanation(result);

    expect(explanation.resource).toBe("activity_writes");
    expect(explanation.limit).toBe(100);
    expect(explanation.remaining).toBe(95);
    expect(explanation.used).toBe(5);
    expect(explanation.resetAt).toBe("2026-07-25T00:00:00.000Z");
    expect(explanation.windowSize).toBe("daily");
    expect(explanation.policy).toBe("platform");
    expect(explanation.explanation).toBe("Used 5 of 100 (platform daily quota). 95 remaining.");
    expect(explanation.ok).toBe(true);
  });

  it("includes ok:false for exceeded quota", () => {
    const result = {
      ok: false,
      limit: 10,
      remaining: 0,
      used: 11,
      resetAt: new Date("2026-07-25T00:00:00.000Z").getTime(),
      resource: "job_writes" as QuotaResource,
      windowSize: "hourly" as WindowSize,
      policy: "agent" as const,
      explanation: "Quota exceeded: used 11 of 10 (agent hourly quota). Resets at 2026-07-25T00:00:00.000Z.",
    };

    const explanation = buildQuotaExplanation(result);

    expect(explanation.ok).toBe(false);
    expect(explanation.explanation).toContain("Quota exceeded");
  });
});

// ─── quotaExceededResponse — includes explanation in body ────────────────────

describe("quotaExceededResponse — body includes explanation", () => {
  const exceeded = {
    ok: false,
    limit: 100,
    remaining: 0,
    used: 101,
    resetAt: new Date("2026-07-25T00:00:00.000Z").getTime(),
    resource: "activity_writes" as QuotaResource,
    windowSize: "daily" as WindowSize,
    policy: "agent" as const,
    explanation: "Quota exceeded: used 101 of 100 (agent daily quota). Resets at 2026-07-25T00:00:00.000Z.",
  };

  it("body contains explanation fields", async () => {
    const resp = quotaExceededResponse(exceeded);
    const body = await resp.json();

    expect(body.error).toBe("Quota exceeded");
    expect(body.resource).toBe("activity_writes");
    expect(body.limit).toBe(100);
    expect(body.resetAt).toBe("2026-07-25T00:00:00.000Z");
    expect(body.windowSize).toBe("daily");
    expect(body.policy).toBe("agent");
    expect(body.explanation).toContain("Quota exceeded");
    expect(body.ok).toBe(false);
  });
});
