import { describe, it, expect } from "vitest";
import { runScenario } from "./runner";

/**
 * Load test: does the rate limiter on /api/health/live enforce its
 * configured limit correctly under real concurrent traffic?
 *
 * Requires a live dev server on localhost:3000 (`pnpm dev` in another
 * terminal). Skipped by default — see package.json's `test:load` script.
 */
describe("liveness endpoint under load", () => {
  it("enforces the read rate limit and reports zero unexpected failures", async () => {
    const scenario = {
      name: "liveness-smoke",
      concurrency: 5,
      durationMs: 3000,
    };

    const result = await runScenario(scenario, "http://localhost:3000/api/health/live");

    // The read rate limit defaults to 100 req/min — expect roughly that
    // many successes, with everything past it correctly rate-limited.
    expect(result.successCount).toBeGreaterThan(0);
    expect(result.successCount).toBeLessThanOrEqual(100);
    expect(result.failureCount).toBe(0);
    expect(result.successCount + result.rateLimitedCount).toBe(
      result.successCount + result.rateLimitedCount + result.failureCount
    );
  });
});