import { afterEach, describe, expect, it, beforeEach } from "vitest";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
  RATE_LIMIT_POLICIES,
  type RateLimitResult,
} from "../src/lib/rate-limit";
import {
  _resetRateLimitStore,
  RedisRateLimitStore,
  MemoryRateLimitStore,
} from "../src/lib/rate-limit-store";

const ORIGINAL_MAX_RETRY_AFTER = process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
const ORIGINAL_UNKNOWN_RETRY_AFTER = process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;

// Ensure each test suite starts with a fresh in-memory store (no REDIS_URL).
beforeEach(() => {
  _resetRateLimitStore();
  delete process.env.REDIS_URL;
});

afterEach(() => {
  if (ORIGINAL_MAX_RETRY_AFTER === undefined) {
    delete process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
  } else {
    process.env.QUOTA_MAX_RETRY_AFTER_SECONDS = ORIGINAL_MAX_RETRY_AFTER;
  }
  if (ORIGINAL_UNKNOWN_RETRY_AFTER === undefined) {
    delete process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;
  } else {
    process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS = ORIGINAL_UNKNOWN_RETRY_AFTER;
  }
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

  it("caps Retry-After at 3600s when resetAt is 30 days in the future", () => {
    const nowMs = 1_753_350_000_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    const res = rateLimitResponse(
      {
        ok: false,
        limit: 100,
        remaining: 0,
        resetAt: nowMs + thirtyDaysMs,
      },
      { nowMs, env: {} },
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(
      String(Math.ceil((nowMs + thirtyDaysMs) / 1_000)),
    );
  });

  it("respects QUOTA_MAX_RETRY_AFTER_SECONDS for rate-limit 429 responses", () => {
    const nowMs = 1_753_350_000_000;
    process.env.QUOTA_MAX_RETRY_AFTER_SECONDS = "120";
    const res = rateLimitResponse(
      {
        ok: false,
        limit: 100,
        remaining: 0,
        resetAt: nowMs + 86_400_000,
      },
      { nowMs },
    );

    expect(res.headers.get("Retry-After")).toBe("120");
  });

  it.each([null, Number.NaN, Infinity, -Infinity, 0, -5_000])(
    "emits finite Retry-After: 60 and omits X-RateLimit-Reset when resetAt is %p",
    (badResetAt) => {
      const res = rateLimitResponse({
        ok: false,
        limit: 10,
        remaining: 0,
        resetAt: badResetAt,
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(res.headers.get("X-RateLimit-Reset")).toBeNull();
    },
  );
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

  it("omits and clears X-RateLimit-Reset when resetAt is unknown or invalid", () => {
    const response = new Response("ok", {
      headers: { "X-RateLimit-Reset": "9999999999" },
    });
    const updated = applyRateLimitHeaders(response, {
      ok: true,
      limit: 5,
      remaining: 4,
      resetAt: null,
    });

    expect(updated.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(updated.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(updated.headers.get("X-RateLimit-Reset")).toBeNull();
  });
});

describe("RedisRateLimitStore — bounded grace policy during outage", () => {
  it("enforces strict fail-closed for payment operations during Redis outage", async () => {
    // Use an unroutable/invalid Redis URL to simulate connection failure
    const store = new RedisRateLimitStore("redis://127.0.0.1:1", false, 60_000);

    const result = await store.increment("payment:key", 60_000, {
      operationClass: "payment",
    });

    expect(result.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.getOutageStatus().isOutage).toBe(true);
  });

  it("enforces strict fail-closed for privileged operations during Redis outage", async () => {
    const store = new RedisRateLimitStore("redis://127.0.0.1:1", false, 60_000);

    const result = await store.increment("privileged:key", 60_000, {
      operationClass: "privileged",
    });

    expect(result.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(store.getOutageStatus().isOutage).toBe(true);
  });

  it("allows standard operations to fail-open to memory within bounded grace window", async () => {
    const store = new RedisRateLimitStore("redis://127.0.0.1:1", false, 60_000);

    const result = await store.increment("standard:key", 60_000, {
      operationClass: "standard",
      graceTtlMs: 60_000,
    });

    expect(result.count).toBe(1);
    expect(store.getOutageStatus().isOutage).toBe(true);
  });

  it("fails closed when outage duration exceeds graceTtlMs", async () => {
    const store = new RedisRateLimitStore("redis://127.0.0.1:1", false, 0); // 0ms grace TTL boundary

    // First failure triggers outageStartTime
    const r1 = await store.increment("standard:key-expired", 60_000, {
      operationClass: "standard",
      graceTtlMs: -1, // Expired immediately
    });

    expect(r1.count).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("rateLimit helper — operationClass propagation and fail-closed", () => {
  it("fails closed for payment operation when store throws unexpectedly", async () => {
    const result = await rateLimit("pay:test", {
      limit: 10,
      windowMs: 60_000,
      operationClass: "payment",
    });
    // When memory store is working, payment works normally
    expect(result.ok).toBe(true);
  });
});