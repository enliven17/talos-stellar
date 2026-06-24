import { describe, it, expect, beforeEach, vi } from "vitest";
import { rateLimit, rateLimitResponse, addRateLimitHeaders, getClientIp, withRateLimit, store } from "@/lib/rate-limit";

describe("rateLimit utility", () => {
  beforeEach(() => {
    // Clear the in-memory store before each test
    store.clear();
  });

  describe("rateLimit()", () => {
    it("allows requests within limit", () => {
      const result = rateLimit("test-key", { limit: 5, windowMs: 60000 });
      expect(result.ok).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.limit).toBe(5);
    });

    it("counts requests correctly", () => {
      const key = "count-test";
      rateLimit(key, { limit: 3, windowMs: 60000 });
      rateLimit(key, { limit: 3, windowMs: 60000 });
      const result = rateLimit(key, { limit: 3, windowMs: 60000 });
      
      expect(result.ok).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it("rejects requests over limit", () => {
      const key = "over-limit-test";
      rateLimit(key, { limit: 2, windowMs: 60000 });
      rateLimit(key, { limit: 2, windowMs: 60000 });
      const result = rateLimit(key, { limit: 2, windowMs: 60000 });
      
      expect(result.ok).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("resets after window expires", async () => {
      const key = "reset-test";
      const shortWindow = 100; // 100ms
      
      rateLimit(key, { limit: 1, windowMs: shortWindow });
      const firstResult = rateLimit(key, { limit: 1, windowMs: shortWindow });
      expect(firstResult.ok).toBe(false);
      
      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150));
      
      const secondResult = rateLimit(key, { limit: 1, windowMs: shortWindow });
      expect(secondResult.ok).toBe(true);
    });

    it("handles different keys independently", () => {
      rateLimit("key1", { limit: 1, windowMs: 60000 });
      const result1 = rateLimit("key1", { limit: 1, windowMs: 60000 });
      expect(result1.ok).toBe(false);
      
      const result2 = rateLimit("key2", { limit: 1, windowMs: 60000 });
      expect(result2.ok).toBe(true);
    });
  });

  describe("rateLimitResponse()", () => {
    it("returns 429 status with correct headers", () => {
      const result = {
        ok: false,
        limit: 10,
        remaining: 0,
        resetAt: Date.now() + 60000,
      };
      
      const response = rateLimitResponse(result);
      
      expect(response.status).toBe(429);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("Retry-After")).toBeDefined();
    });

    it("includes Retry-After header", () => {
      const resetAt = Date.now() + 30000;
      const result = {
        ok: false,
        limit: 5,
        remaining: 0,
        resetAt,
      };
      
      const response = rateLimitResponse(result);
      const retryAfter = response.headers.get("Retry-After");
      
      expect(retryAfter).toBeDefined();
      const retryAfterNum = parseInt(retryAfter!, 10);
      expect(retryAfterNum).toBeGreaterThan(0);
      expect(retryAfterNum).toBeLessThanOrEqual(30);
    });
  });

  describe("addRateLimitHeaders()", () => {
    it("adds rate limit headers to response", () => {
      const result = {
        ok: true,
        limit: 100,
        remaining: 95,
        resetAt: Date.now() + 60000,
      };
      
      const response = new Response(JSON.stringify({ data: "test" }));
      const enhanced = addRateLimitHeaders(response, result);
      
      expect(enhanced.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(enhanced.headers.get("X-RateLimit-Remaining")).toBe("95");
      expect(enhanced.headers.get("X-RateLimit-Reset")).toBeDefined();
      expect(enhanced.headers.get("Retry-After")).toBeNull();
    });
  });

  describe("getClientIp()", () => {
    it("extracts IP from x-forwarded-for header", () => {
      const request = new Request("http://test.com", {
        headers: { "x-forwarded-for": "192.168.1.1, 10.0.0.1" },
      });
      const ip = getClientIp(request);
      expect(ip).toBe("192.168.1.1");
    });

    it("extracts IP from x-real-ip header", () => {
      const request = new Request("http://test.com", {
        headers: { "x-real-ip": "192.168.1.2" },
      });
      const ip = getClientIp(request);
      expect(ip).toBe("192.168.1.2");
    });

    it("extracts IP from cf-connecting-ip header", () => {
      const request = new Request("http://test.com", {
        headers: { "cf-connecting-ip": "192.168.1.3" },
      });
      const ip = getClientIp(request);
      expect(ip).toBe("192.168.1.3");
    });

    it("returns unknown when no IP headers present", () => {
      const request = new Request("http://test.com");
      const ip = getClientIp(request);
      expect(ip).toBe("unknown");
    });

    it("prioritizes x-forwarded-for over other headers", () => {
      const request = new Request("http://test.com", {
        headers: {
          "x-forwarded-for": "192.168.1.1",
          "x-real-ip": "192.168.1.2",
          "cf-connecting-ip": "192.168.1.3",
        },
      });
      const ip = getClientIp(request);
      expect(ip).toBe("192.168.1.1");
    });
  });

  describe("withRateLimit()", () => {
    it("wraps handler and adds rate limit headers on success", async () => {
      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }))
      );
      
      const wrapped = withRateLimit(handler, { limit: 10, windowMs: 60000 }, "test");
      const request = new Request("http://test.com");
      
      const response = await wrapped(request);
      
      expect(handler).toHaveBeenCalledWith(request);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBeDefined();
    });

    it("returns 429 when rate limit exceeded", async () => {
      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }))
      );
      
      const wrapped = withRateLimit(handler, { limit: 1, windowMs: 60000 }, "test");
      const request = new Request("http://test.com");
      
      // First request should succeed
      await wrapped(request);
      
      // Second request should be rate limited
      const response = await wrapped(request);
      
      expect(response.status).toBe(429);
      expect(handler).toHaveBeenCalledTimes(1); // Handler should only be called on first request
    });

    it("passes additional arguments to handler", async () => {
      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }))
      );
      
      const wrapped = withRateLimit(handler, { limit: 10, windowMs: 60000 }, "test");
      const request = new Request("http://test.com");
      const extraArg = { id: "test-id" };
      
      await wrapped(request, extraArg);
      
      expect(handler).toHaveBeenCalledWith(request, extraArg);
    });

    it("uses key prefix for rate limit key", async () => {
      const handler = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }))
      );
      
      const wrapped1 = withRateLimit(handler, { limit: 1, windowMs: 60000 }, "prefix1");
      const wrapped2 = withRateLimit(handler, { limit: 1, windowMs: 60000 }, "prefix2");
      const request = new Request("http://test.com");
      
      // Both should succeed since they have different prefixes
      const response1 = await wrapped1(request);
      const response2 = await wrapped2(request);
      
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });
  });
});
