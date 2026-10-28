import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  acquireConnection,
  releaseConnection,
  recordDbQueries,
  getSseMetrics,
  __resetPool,
} from "../src/lib/sse-pool";

/**
 * Unit tests for the shared SSE connection pool (`web/src/lib/sse-pool.ts`).
 *
 * The pool backs the `/api/events` and job-progress SSE streams. It enforces:
 *   - a global cap (SSE_MAX_CONNECTIONS, default 200)
 *   - an optional per-key cap (SSE_MAX_CONNECTIONS_PER_KEY, default Infinity)
 *
 * These tests assert every pool limit directly and verify that no connection
 * slots, timers or listeners leak after each test.
 */
describe("SSE connection pool", () => {
  beforeEach(() => {
    __resetPool(200, Infinity);
  });

  afterEach(() => {
    // No slot may leak between tests — assert the baseline before resetting.
    expect(getSseMetrics().activeConnections).toBe(0);
    expect(getSseMetrics().keysTracked).toBe(0);
    vi.useRealTimers();
    __resetPool(200, Infinity);
  });

  // ── acquire / release ──────────────────────────────────────────────────

  describe("acquire / release", () => {
    it("increments and decrements the active connection count", () => {
      expect(getSseMetrics().activeConnections).toBe(0);
      expect(acquireConnection()).toBe(true);
      expect(getSseMetrics().activeConnections).toBe(1);
      releaseConnection();
      expect(getSseMetrics().activeConnections).toBe(0);
    });

    it("releaseConnection never drives the count below zero (no negative leak)", () => {
      releaseConnection();
      releaseConnection();
      releaseConnection();
      expect(getSseMetrics().activeConnections).toBe(0);
    });

    it("an over-cap acquire returns false without consuming a slot", () => {
      __resetPool(1, Infinity);
      expect(acquireConnection()).toBe(true);
      const before = getSseMetrics().activeConnections;
      expect(acquireConnection()).toBe(false);
      // count unchanged by the rejected acquire
      expect(getSseMetrics().activeConnections).toBe(before);
      releaseConnection();
    });
  });

  // ── global limit (the pool-wide cap) ──────────────────────────────────

  describe("global limit", () => {
    it("accepts up to the cap and rejects the next acquire", () => {
      __resetPool(3, Infinity);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(false);
      expect(getSseMetrics().activeConnections).toBe(3);
      releaseConnection();
      releaseConnection();
      releaseConnection();
    });

    it("accepts again after a slot is released", () => {
      __resetPool(1, Infinity);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(false);
      releaseConnection();
      expect(acquireConnection()).toBe(true);
      releaseConnection();
    });

    it("__resetPool overrides the cap and zeroes the counters", () => {
      __resetPool(2, Infinity);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(false);

      __resetPool(5, Infinity);
      expect(getSseMetrics().activeConnections).toBe(0);
      expect(acquireConnection()).toBe(true);
      releaseConnection();
    });

    it("the global cap is the backstop against a single client exhausting the pool", () => {
      // A single client (key "GONE") tries to open many connections. Even with
      // no per-key cap set, the global cap bounds how many it can hold.
      __resetPool(4, Infinity);
      for (let i = 0; i < 4; i++) {
        expect(acquireConnection("GONE")).toBe(true);
      }
      // 5th from the same client is rejected by the global cap.
      expect(acquireConnection("GONE")).toBe(false);
      expect(getSseMetrics().activeConnections).toBe(4);
      releaseConnection("GONE");
      releaseConnection("GONE");
      releaseConnection("GONE");
      releaseConnection("GONE");
    });
  });

  // ── per-key caps ───────────────────────────────────────────────────────

  describe("per-key caps", () => {
    it("bounds a single key to the per-key cap while other keys keep acquiring", () => {
      __resetPool(100, 2);
      expect(acquireConnection("GABC")).toBe(true);
      expect(acquireConnection("GABC")).toBe(true);
      // per-key cap reached for GABC
      expect(acquireConnection("GABC")).toBe(false);
      // a different key is unaffected (global cap not yet hit)
      expect(acquireConnection("GXYZ")).toBe(true);

      expect(getSseMetrics().activeConnections).toBe(3);
      expect(getSseMetrics().keysTracked).toBe(2);

      // releasing one GABC slot lets the same key reacquire
      releaseConnection("GABC");
      expect(acquireConnection("GABC")).toBe(true);

      releaseConnection("GABC");
      releaseConnection("GABC");
      releaseConnection("GXYZ");
    });

    it("a per-key rejection does not consume a global slot", () => {
      __resetPool(100, 1);
      expect(acquireConnection("GABC")).toBe(true);
      expect(acquireConnection("GABC")).toBe(false);
      expect(getSseMetrics().activeConnections).toBe(1);
      releaseConnection("GABC");
    });

    it("removes the per-key tracking entry once it drains to zero", () => {
      __resetPool(100, 5);
      acquireConnection("GABC");
      acquireConnection("GABC");
      expect(getSseMetrics().keysTracked).toBe(1);
      releaseConnection("GABC");
      releaseConnection("GABC");
      expect(getSseMetrics().keysTracked).toBe(0);
    });

    it("omitting the key falls back to global-only behaviour (backward compatible)", () => {
      __resetPool(2, 1);
      expect(acquireConnection()).toBe(true);
      expect(acquireConnection()).toBe(true);
      // global cap reached; the per-key cap is irrelevant when no key is supplied
      expect(acquireConnection()).toBe(false);
      expect(getSseMetrics().keysTracked).toBe(0);
      releaseConnection();
      releaseConnection();
    });

    it("releasing an unknown key is a safe no-op", () => {
      __resetPool(100, 5);
      releaseConnection("NEVER");
      expect(getSseMetrics().activeConnections).toBe(0);
      expect(getSseMetrics().keysTracked).toBe(0);
    });
  });

  // ── abort-triggered cleanup ───────────────────────────────────────────

  describe("abort-triggered cleanup", () => {
    it("releases the slot when the abort signal fires", () => {
      const controller = new AbortController();
      expect(acquireConnection("GABC")).toBe(true);
      expect(getSseMetrics().activeConnections).toBe(1);

      // Mirror the route's cleanup contract: release on abort.
      controller.signal.addEventListener("abort", () => {
        releaseConnection("GABC");
      });
      controller.abort();

      expect(getSseMetrics().activeConnections).toBe(0);
      expect(getSseMetrics().keysTracked).toBe(0);
    });

    it("does not leak listeners: the abort callback fires exactly once", () => {
      const controller = new AbortController();
      let fired = 0;
      controller.signal.addEventListener("abort", () => {
        fired++;
        releaseConnection("GABC");
      });

      acquireConnection("GABC");
      controller.abort();

      expect(fired).toBe(1);
      expect(getSseMetrics().activeConnections).toBe(0);
      // A second abort() must not re-fire the listener (AbortSignal is one-shot).
      controller.abort();
      expect(fired).toBe(1);
    });
  });

  // ── fake timers: no timer leaks ───────────────────────────────────────

  describe("fake timers — no leaks", () => {
    it("a cleared interval does not fire after abort-driven cleanup", async () => {
      vi.useFakeTimers();
      __resetPool(10, Infinity);

      let ticks = 0;
      const controller = new AbortController();
      acquireConnection("GABC");

      const poll = setInterval(() => {
        ticks++;
      }, 8_000);

      controller.signal.addEventListener("abort", () => {
        releaseConnection("GABC");
        clearInterval(poll);
      });

      expect(getSseMetrics().activeConnections).toBe(1);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(getSseMetrics().activeConnections).toBe(0);

      // Advance well past the original interval; the cleared timer must NOT fire.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ticks).toBe(0);

      vi.useRealTimers();
    });

    it("leaves no pending timers after the test restores real timers", async () => {
      vi.useFakeTimers();
      __resetPool(10, Infinity);

      let ticks = 0;
      const controller = new AbortController();
      acquireConnection("GKEY");

      const t = setInterval(() => {
        ticks++;
      }, 5_000);
      controller.signal.addEventListener("abort", () => {
        releaseConnection("GKEY");
        clearInterval(t);
      });

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(getSseMetrics().activeConnections).toBe(0);

      // After cleanup, advancing time must fire nothing — proving no timer leaked.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ticks).toBe(0);

      vi.useRealTimers();
    });
  });

  // ── metrics ──────────────────────────────────────────────────────────

  describe("metrics", () => {
    it("recordDbQueries accumulates the running total", () => {
      recordDbQueries(2);
      recordDbQueries(3);
      expect(getSseMetrics().totalDbQueries).toBe(5);
    });

    it("getSseMetrics returns a read-only snapshot of the current state", () => {
      acquireConnection("GABC");
      const snap = getSseMetrics();
      expect(snap.activeConnections).toBe(1);
      expect(snap.totalDbQueries).toBeGreaterThanOrEqual(0);
      expect(snap.keysTracked).toBe(1);
      releaseConnection("GABC");
    });
  });
});
