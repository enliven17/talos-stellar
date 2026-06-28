import { describe, expect, it } from "vitest";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
} from "../src/lib/rate-limit";

describe("rate limit headers", () => {
  it("adds rate-limit headers to successful responses", () => {
    const result = rateLimit("test-success", {
      limit: 5,
      windowMs: 60_000,
    });

    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);

    expect(updated.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(updated.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(updated.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("adds retry-after on throttled responses", () => {
    rateLimit("test-fail", {
      limit: 1,
      windowMs: 60_000,
    });

    const exceeded = rateLimit("test-fail", {
      limit: 1,
      windowMs: 60_000,
    });

    const response = rateLimitResponse(exceeded);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});