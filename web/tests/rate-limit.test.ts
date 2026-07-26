import { describe, expect, it, beforeEach } from "vitest";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
} from "../src/lib/rate-limit";
import { _resetRateLimitStore } from "../src/lib/rate-limit-store";

// Ensure each test suite starts with a fresh in-memory store (no REDIS_URL).
beforeEach(() => {
  _resetRateLimitStore();
  delete process.env.REDIS_URL;
});

describe("rate limit headers", () => {
  it("adds rate-limit headers to successful responses", async () => {
    const result = await rateLimit("test-success", {
      limit: 5,
      windowMs: 60_000,
    });

    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);

    expect(updated.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(updated.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(updated.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("adds retry-after on throttled responses", async () => {
    await rateLimit("test-fail", { limit: 1, windowMs: 60_000 });
    const exceeded = await rateLimit("test-fail", { limit: 1, windowMs: 60_000 });

    const response = rateLimitResponse(exceeded);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("rate limit logic", () => {
  it("allows requests within quota", async () => {
    const key = `logic-ok-${Date.now()}`;
    const r1 = await rateLimit(key, { limit: 3, windowMs: 60_000 });
    const r2 = await rateLimit(key, { limit: 3, windowMs: 60_000 });
    const r3 = await rateLimit(key, { limit: 3, windowMs: 60_000 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over quota", async () => {
    const key = `logic-block-${Date.now()}`;
    await rateLimit(key, { limit: 1, windowMs: 60_000 });
    const exceeded = await rateLimit(key, { limit: 1, windowMs: 60_000 });

    expect(exceeded.ok).toBe(false);
    expect(exceeded.remaining).toBe(0);
  });

  it("resets counter after window expires", async () => {
    const key = `logic-reset-${Date.now()}`;
    // Use a very short window to test expiry without actually waiting.
    const r1 = await rateLimit(key, { limit: 1, windowMs: 1 });
    expect(r1.ok).toBe(true);

    // Wait for the window to expire.
    await new Promise((res) => setTimeout(res, 5));

    const r2 = await rateLimit(key, { limit: 1, windowMs: 1 });
    expect(r2.ok).toBe(true);
  });

  it("uses separate buckets for different keys", async () => {
    const ts = Date.now();
    const r1 = await rateLimit(`separate-a-${ts}`, { limit: 1, windowMs: 60_000 });
    const r2 = await rateLimit(`separate-b-${ts}`, { limit: 1, windowMs: 60_000 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

describe("rateLimitResponse shape", () => {
  it("returns 429 with all required headers", async () => {
    const key = `resp-${Date.now()}`;
    await rateLimit(key, { limit: 1, windowMs: 60_000 });
    const exceeded = await rateLimit(key, { limit: 1, windowMs: 60_000 });
    const res = rateLimitResponse(exceeded);

    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(res.headers.get("Retry-After")).toBeTruthy();

    const body = await res.json();
    expect(body).toEqual({ error: "Too many requests" });
  });
});
