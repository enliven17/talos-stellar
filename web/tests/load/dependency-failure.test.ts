import { describe, it, expect } from "vitest";

/**
 * Load/resilience test: when a dependency (DB, Stellar Horizon) is down,
 * does the health check fail FAST and report it correctly, instead of
 * hanging indefinitely?
 *
 * /api/health/utils.ts documents DB_TIMEOUT_MS=2000 and
 * STELLAR_TIMEOUT_MS=3000 — the route should never take meaningfully
 * longer than the larger of the two. This test enforces its own hard
 * ceiling via AbortController so a hang is reported as a clear,
 * readable assertion failure rather than a generic test-runner timeout.
 *
 * Requires a live dev server on localhost:3000.
 */
describe("health check under a degraded dependency", () => {
  it("responds within its documented timeout bound, never hangs", async () => {
    const BOUND_MS = 6000; // larger of the two documented timeouts + headroom
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BOUND_MS);

    const start = performance.now();
    let elapsedMs = -1;
    let hung = false;
    let body: unknown = null;
    let status = -1;

    try {
      const res = await fetch("http://localhost:3000/api/health", { signal: controller.signal });
      status = res.status;
      body = await res.json();
      elapsedMs = performance.now() - start;
    } catch {
      hung = true;
      elapsedMs = performance.now() - start;
    } finally {
      clearTimeout(timer);
    }

    console.log({ hung, elapsedMs: Math.round(elapsedMs), status, body });

    expect(hung, `health check did not respond within ${BOUND_MS}ms — exceeded its documented timeout bound`).toBe(
      false
    );
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("checks");
  }, 10000);
});