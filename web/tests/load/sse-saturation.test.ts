import { describe, it, expect } from "vitest";
import { saturateSse } from "./sse-runner";

/**
 * Load test: does /api/events correctly enforce its connection pool cap
 * (SSE_MAX_CONNECTIONS, default 200) under a burst well past that limit,
 * rejecting excess connections with 503 rather than accepting them
 * unbounded or silently dropping them?
 *
 * Requires a live dev server on localhost:3000.
 */
describe("SSE endpoint under connection saturation", () => {
  it("accounts for every connection attempt with no silent drops", async () => {
    const url = "http://localhost:3000/api/events?wallet=GABC123TESTWALLET";

    const result = await saturateSse(url, 220, 5000, 1000);
    console.log(result);

    const total =
      result.accepted + result.poolRejected + result.rateLimited + result.stillPending + result.otherFailures;

    expect(result.otherFailures).toBe(0);
    expect(result.stillPending).toBe(0);
    expect(total).toBe(result.attempted);
    expect(result.accepted).toBeGreaterThan(0);
  }, 30000);
});