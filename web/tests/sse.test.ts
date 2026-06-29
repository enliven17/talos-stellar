import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mock factories ───────────────────────────────────────────────────
// vi.hoisted runs before vi.mock, so these refs are available inside factories.

const mocks = vi.hoisted(() => {
  let _selectCallCount = 0;

  // Builds a chainable Drizzle query-builder mock that resolves to `result`
  // when awaited (the `.then` implementation makes it a thenable).
  function makeSelectChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = vi.fn(self);
    chain.where = vi.fn(self);
    chain.orderBy = vi.fn(self);
    chain.limit = vi.fn(self);
    chain.then = vi.fn(
      (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    );
    return chain;
  }

  const dbSelect = vi.fn(() => {
    const n = _selectCallCount++;
    // Call 0 → patrons query  → no patron memberships
    // Call 1 → owners query   → one owned TALOS so poll() actually runs
    // Call 2+ → poll queries  → no new approvals / activities
    const result = n === 1 ? [{ id: "talos-abc" }] : [];
    return makeSelectChain(result);
  });

  return {
    dbSelect,
    makeSelectChain,
    getSelectCallCount: () => _selectCallCount,
    resetSelectCallCount: () => { _selectCallCount = 0; },
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/db", () => ({
  db: { select: mocks.dbSelect },
}));

vi.mock("@/db/schema", () => ({
  tlsTalos:      { id: "id", walletPublicKey: "w", creatorPublicKey: "c", investorPublicKey: "i", treasuryPublicKey: "t" },
  tlsPatrons:    { talosId: "talosId", stellarPublicKey: "spk" },
  tlsApprovals:  { id: "id", talosId: "talosId", createdAt: "createdAt" },
  tlsActivities: { id: "id", talosId: "talosId", createdAt: "createdAt" },
}));

vi.mock("drizzle-orm", () => ({
  desc:    vi.fn(),
  eq:      vi.fn(),
  or:      vi.fn(),
  inArray: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from "@/app/api/events/route";
import { getSseMetrics, __resetPool } from "@/lib/sse-pool";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(signal?: AbortSignal) {
  return new NextRequest("http://localhost/api/events?wallet=GABC123", { signal });
}

// Flush pending microtasks so async ReadableStream.start() progresses.
async function flushMicrotasks(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetSelectCallCount();
    __resetPool(200);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Missing wallet param ───────────────────────────────────────────────────

  it("returns 400 when wallet param is absent", async () => {
    const req = new NextRequest("http://localhost/api/events");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // ── Connection cap ─────────────────────────────────────────────────────────

  describe("connection cap", () => {
    it("returns 503 with Retry-After when the cap is exceeded", async () => {
      __resetPool(2); // cap = 2 for this test

      const controllers = [new AbortController(), new AbortController()];

      const r1 = await GET(makeRequest(controllers[0].signal));
      const r2 = await GET(makeRequest(controllers[1].signal));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(getSseMetrics().activeConnections).toBe(2);

      // 3rd connection exceeds the cap of 2.
      const r3 = await GET(makeRequest(new AbortController().signal));
      expect(r3.status).toBe(503);
      expect(r3.headers.get("Retry-After")).toBe("10");

      // Abort the first two so the pool resets cleanly for subsequent tests.
      controllers.forEach((c) => c.abort());
    });

    it("accepts a new connection after one is released", async () => {
      __resetPool(1);

      const c1 = new AbortController();
      const r1 = await GET(makeRequest(c1.signal));
      expect(r1.status).toBe(200);

      // Pool is full — new connection should be rejected.
      const r2 = await GET(makeRequest());
      expect(r2.status).toBe(503);

      // Abort first connection; wait for async cleanup inside the stream.
      c1.abort();
      await flushMicrotasks();

      // Pool slot is now free — next connection should succeed.
      const r3 = await GET(makeRequest(new AbortController().signal));
      expect(r3.status).toBe(200);
    });
  });

  // ── TalosId cache ──────────────────────────────────────────────────────────

  describe("getTalosIds cache", () => {
    it("fetches talosIds exactly once per connection across multiple poll cycles", async () => {
      vi.useFakeTimers();
      __resetPool(200);

      const controller = new AbortController();
      await GET(makeRequest(controller.signal));

      // Flush microtasks so fetchTalosIds() resolves and the poll timer is registered.
      await flushMicrotasks();

      const callsAfterInit = mocks.getSelectCallCount();
      // Exactly 2 DB queries: one for patrons, one for owners.
      expect(callsAfterInit).toBe(2);

      // Advance time to fire 3 poll cycles.
      await vi.advanceTimersByTimeAsync(3 * 8_000);

      const callsAfter3Polls = mocks.getSelectCallCount();
      // Each poll issues 2 queries (approvals + activities).
      // Total with cached talosIds: 2 (init) + 3×2 (polls) = 8.
      // Original uncached code would have been: 3×2 (talosIds) + 3×2 (polls) = 12.
      expect(callsAfter3Polls).toBe(2 + 3 * 2);

      controller.abort();
    });
  });

  // ── Zombie / cleanup ───────────────────────────────────────────────────────

  describe("zombie connection cleanup", () => {
    it("decrements the active connection count when the client aborts", async () => {
      __resetPool(200);
      const controller = new AbortController();

      await GET(makeRequest(controller.signal));
      // Let the stream's start() progress past await fetchTalosIds() so the
      // abort listener is registered before we fire the abort.
      await flushMicrotasks();

      expect(getSseMetrics().activeConnections).toBe(1);

      controller.abort();
      await flushMicrotasks();

      expect(getSseMetrics().activeConnections).toBe(0);
    });
  });

  // ── Metrics ────────────────────────────────────────────────────────────────

  describe("metrics", () => {
    it("tracks active connection count", async () => {
      __resetPool(200);
      const c1 = new AbortController();
      const c2 = new AbortController();

      await GET(makeRequest(c1.signal));
      await GET(makeRequest(c2.signal));
      expect(getSseMetrics().activeConnections).toBe(2);

      c1.abort();
      await flushMicrotasks();
      expect(getSseMetrics().activeConnections).toBe(1);

      c2.abort();
      await flushMicrotasks();
      expect(getSseMetrics().activeConnections).toBe(0);
    });

    it("records DB queries against the running total", async () => {
      vi.useFakeTimers();
      __resetPool(200);
      const { totalDbQueries: before } = getSseMetrics();

      const controller = new AbortController();
      await GET(makeRequest(controller.signal));
      await flushMicrotasks();

      // Initial fetch: 2 queries.
      expect(getSseMetrics().totalDbQueries - before).toBe(2);

      // One poll cycle: 2 more.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(getSseMetrics().totalDbQueries - before).toBe(4);

      controller.abort();
    });
  });

  // ── SSE headers ───────────────────────────────────────────────────────────

  it("returns correct SSE response headers", async () => {
    const controller = new AbortController();
    const res = await GET(makeRequest(controller.signal));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    controller.abort();
  });
});
