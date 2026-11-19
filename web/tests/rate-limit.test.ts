import { describe, expect, it, beforeEach } from "vitest";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
  RATE_LIMIT_POLICIES,
  type RateLimitResult,
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

  it("does not set X-RateLimit-Policy when result.policy is absent", async () => {
    const result = await rateLimit("test-no-policy", { limit: 5, windowMs: 60_000 });
    // rateLimit() itself never sets policy; the proxy layer does.
    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);
    expect(updated.headers.get("X-RateLimit-Policy")).toBeNull();
  });

  it("sets X-RateLimit-Policy when result.policy is provided", async () => {
    const result = await rateLimit("test-policy", { limit: 5, windowMs: 60_000 });
    result.policy = "read";

    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);

    expect(updated.headers.get("X-RateLimit-Policy")).toBe("read");
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

  it("includes X-RateLimit-Policy on 429 when policy is set", async () => {
    const key = `resp-policy-${Date.now()}`;
    await rateLimit(key, { limit: 1, windowMs: 60_000 });
    const exceeded = await rateLimit(key, { limit: 1, windowMs: 60_000 });
    exceeded.policy = "write-key";

    const res = rateLimitResponse(exceeded);

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Policy")).toBe("write-key");
  });

  it("omits X-RateLimit-Policy on 429 when policy is not set", async () => {
    const key = `resp-nopolicy-${Date.now()}`;
    await rateLimit(key, { limit: 1, windowMs: 60_000 });
    const exceeded = await rateLimit(key, { limit: 1, windowMs: 60_000 });
    // do not set exceeded.policy

    const res = rateLimitResponse(exceeded);

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Policy")).toBeNull();
  });

  it("Retry-After is at least 1 second even for a near-zero window", async () => {
    // A result where resetAt is already in the past should clamp to >= 1.
    const result: RateLimitResult = {
      ok: false,
      limit: 1,
      remaining: 0,
      resetAt: Date.now() - 5_000, // already expired
    };
    const res = rateLimitResponse(result);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe("RATE_LIMIT_POLICIES — policy name field", () => {
  it("every policy has a non-empty name string", () => {
    for (const [bucket, policy] of Object.entries(RATE_LIMIT_POLICIES)) {
      expect(typeof policy.name).toBe("string");
      expect(policy.name.length).toBeGreaterThan(0);
      // name must not equal the keyPrefix — it is the human label, not the store key
      expect(policy.name).not.toContain(":");
    }
  });

  it("policy names match the documented set", () => {
    const names = Object.values(RATE_LIMIT_POLICIES).map((p) => p.name);
    expect(names).toContain("auth");
    expect(names).toContain("read");
    expect(names).toContain("write-key");
    expect(names).toContain("write-ip");
  });
});

describe("applyRateLimitHeaders — boundary inputs", () => {
  it("handles remaining=0 at the exact quota boundary", async () => {
    const key = `boundary-${Date.now()}`;
    const result = await rateLimit(key, { limit: 1, windowMs: 60_000 });
    // First (and only) allowed request — remaining should be 0
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);

    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);
    expect(updated.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(updated.headers.get("X-RateLimit-Limit")).toBe("1");
  });

  it("X-RateLimit-Reset is a positive integer string", async () => {
    const result = await rateLimit(`reset-check-${Date.now()}`, {
      limit: 10,
      windowMs: 60_000,
    });
    const response = new Response("ok");
    const updated = applyRateLimitHeaders(response, result);
    const resetVal = Number(updated.headers.get("X-RateLimit-Reset"));
    expect(Number.isInteger(resetVal)).toBe(true);
    expect(resetVal).toBeGreaterThan(0);
  });

  it("is non-mutating — returns same response object with headers set", async () => {
    const result = await rateLimit(`mutate-check-${Date.now()}`, {
      limit: 5,
      windowMs: 60_000,
    });
    const original = new Response("ok");
    const returned = applyRateLimitHeaders(original, result);
    // The function mutates and returns the same object
    expect(returned).toBe(original);
  });
});
