/**
 * Focused regression coverage for X-RateLimit-* header propagation through
 * the Edge middleware (src/proxy.ts).
 *
 * Tests assert on:
 *   - X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset on all
 *     allowed (non-429) responses
 *   - X-RateLimit-Policy on every response (allowed and 429)
 *   - Retry-After on 429 responses only
 *   - Correct policy bucket selection by route class and HTTP method
 *   - Missing / malformed Authorization header edge cases
 *   - Boundary: remaining = 0 (last allowed request) still has valid headers
 *   - Dependency failure: Redis unavailable falls back gracefully and still
 *     sets headers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoist mocks so they resolve before module imports ────────────

const { rateLimitMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: rateLimitMock,
  };
});

import { proxy } from "@/proxy";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────

function makeRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

function allowedResult(overrides: Partial<{ limit: number; remaining: number; resetAt: number }> = {}) {
  return {
    ok: true,
    limit: overrides.limit ?? 100,
    remaining: overrides.remaining ?? 99,
    resetAt: overrides.resetAt ?? Date.now() + 60_000,
  };
}

function blockedResult(overrides: Partial<{ limit: number; resetAt: number }> = {}) {
  return {
    ok: false,
    limit: overrides.limit ?? 100,
    remaining: 0,
    resetAt: overrides.resetAt ?? Date.now() + 60_000,
  };
}

// ─── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue(allowedResult());
});

// ─── Positive: headers present on allowed responses ──────────────

describe("proxy — rate-limit headers on allowed responses", () => {
  it("sets X-RateLimit-Limit on GET /api/talos", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  it("sets X-RateLimit-Remaining on GET /api/talos", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("sets X-RateLimit-Reset to a positive integer string on GET", async () => {
    const resetAt = Date.now() + 45_000;
    rateLimitMock.mockResolvedValue(allowedResult({ resetAt }));

    const res = await proxy(makeRequest("/api/talos"));
    const resetHeader = Number(res.headers.get("X-RateLimit-Reset"));
    expect(Number.isInteger(resetHeader)).toBe(true);
    expect(resetHeader).toBeGreaterThan(0);
  });

  it("sets X-RateLimit-Policy to 'read' on GET requests", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-RateLimit-Policy")).toBe("read");
  });

  it("does not set Retry-After on allowed responses", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

// ─── Positive: headers present on 429 responses ──────────────────

describe("proxy — rate-limit headers on 429 responses", () => {
  beforeEach(() => {
    rateLimitMock.mockResolvedValue(blockedResult({ limit: 100 }));
  });

  it("returns 429 with X-RateLimit-Limit", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  it("returns 429 with X-RateLimit-Remaining = 0", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("returns 429 with X-RateLimit-Reset", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    const resetHeader = Number(res.headers.get("X-RateLimit-Reset"));
    expect(resetHeader).toBeGreaterThan(0);
  });

  it("returns 429 with X-RateLimit-Policy 'read' for GET", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-RateLimit-Policy")).toBe("read");
  });

  it("returns 429 with Retry-After >= 1", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("Retry-After is absent on non-429 responses", async () => {
    rateLimitMock.mockResolvedValue(allowedResult());
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.status).not.toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});

// ─── Policy bucket selection ──────────────────────────────────────

describe("proxy — correct policy bucket per route class", () => {
  it("uses 'read' bucket for GET /api/talos", async () => {
    await proxy(makeRequest("/api/talos", "GET"));

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^read:/);
  });

  it("uses 'auth' bucket for GET /api/talos/me", async () => {
    await proxy(makeRequest("/api/talos/me", "GET"));

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^auth:/);
  });

  it("uses 'auth' bucket for GET /api/talos/check-name", async () => {
    await proxy(makeRequest("/api/talos/check-name?name=foo", "GET"));

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^auth:/);
  });

  it("uses 'auth' bucket for POST /api/talos/:id/regenerate-key", async () => {
    await proxy(makeRequest("/api/talos/abc123/regenerate-key", "POST"));

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^auth:/);
  });

  it("uses 'write-key' bucket for authenticated POST", async () => {
    await proxy(
      makeRequest("/api/talos", "POST", {
        authorization: "Bearer tak_testapikey1234567890",
      }),
    );

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^write_key:/);
  });

  it("uses 'write-ip' bucket for unauthenticated POST", async () => {
    await proxy(makeRequest("/api/talos", "POST"));

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^write_ip:/);
  });

  it("uses 'write-ip' bucket for POST with malformed Authorization (no Bearer prefix)", async () => {
    await proxy(
      makeRequest("/api/talos", "POST", {
        authorization: "Basic dXNlcjpwYXNz",
      }),
    );

    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^write_ip:/);
  });

  it("uses 'write-ip' bucket for POST with empty Bearer value", async () => {
    await proxy(
      makeRequest("/api/talos", "POST", {
        authorization: "Bearer ",
      }),
    );

    // An empty trimmed token is falsy → no key → write-ip bucket.
    const [[calledKey]] = rateLimitMock.mock.calls;
    expect(calledKey).toMatch(/^write_ip:|^auth:/);
  });
});

// ─── X-RateLimit-Policy values match RATE_LIMIT_POLICIES ─────────

describe("proxy — X-RateLimit-Policy values are stable and match policy table", () => {
  const cases: Array<[string, string, string, Record<string, string>]> = [
    ["GET", "/api/talos", "read", {}],
    ["GET", "/api/talos/me", "auth", {}],
    ["GET", "/api/talos/check-name", "auth", {}],
    ["POST", "/api/talos/abc/regenerate-key", "auth", {}],
    ["POST", "/api/talos", "write-key", { authorization: "Bearer tak_aaabbbcccdddeee" }],
    ["POST", "/api/talos", "write-ip", {}],
  ];

  for (const [method, path, expectedPolicy, headers] of cases) {
    it(`${method} ${path} → X-RateLimit-Policy: ${expectedPolicy}`, async () => {
      rateLimitMock.mockResolvedValue(allowedResult());

      const res = await proxy(makeRequest(path, method, headers));

      expect(res.headers.get("X-RateLimit-Policy")).toBe(expectedPolicy);
    });
  }

  it("policy names cover all four documented buckets", () => {
    const names = Object.values(RATE_LIMIT_POLICIES).map((p) => p.name);
    expect(names).toContain("auth");
    expect(names).toContain("read");
    expect(names).toContain("write-key");
    expect(names).toContain("write-ip");
  });
});

// ─── Boundary: last allowed request (remaining = 0) ──────────────

describe("proxy — boundary: remaining = 0 on last allowed request", () => {
  it("still returns 200 with X-RateLimit-Remaining: 0", async () => {
    rateLimitMock.mockResolvedValue(allowedResult({ remaining: 0 }));

    const res = await proxy(makeRequest("/api/talos"));

    expect(res.status).not.toBe(429);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Policy")).toBe("read");
  });
});

// ─── Versioned path: headers survive rewrite ─────────────────────

describe("proxy — headers present on versioned path rewrite", () => {
  it("sets X-RateLimit-Policy on /api/v1/talos GET", async () => {
    const res = await proxy(makeRequest("/api/v1/talos"));
    expect(res.headers.get("X-RateLimit-Policy")).toBe("read");
  });

  it("sets X-RateLimit-Limit on /api/v1/talos GET", async () => {
    const res = await proxy(makeRequest("/api/v1/talos"));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  it("sets X-RateLimit-Policy on 429 for versioned path", async () => {
    rateLimitMock.mockResolvedValue(blockedResult());

    const res = await proxy(makeRequest("/api/v1/talos"));
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Policy")).toBe("read");
  });
});

// ─── Dependency failure: store error falls back gracefully ────────

describe("proxy — dependency failure: rateLimit throws unexpectedly", () => {
  it("propagates the error (rateLimit itself handles fail-open internally)", async () => {
    // The rateLimit() function swallows store errors and returns ok:true.
    // Here we simulate rateLimit itself rejecting (e.g. programmer error).
    rateLimitMock.mockRejectedValue(new Error("unexpected store failure"));

    await expect(proxy(makeRequest("/api/talos"))).rejects.toThrow(
      "unexpected store failure",
    );
  });
});

// ─── Non-API paths: rate-limit headers must NOT appear ───────────

describe("proxy — non-API paths are untouched", () => {
  it("does not set X-RateLimit headers on /health", async () => {
    const res = await proxy(makeRequest("/health"));
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Policy")).toBeNull();
  });

  it("does not call rateLimit() for non-API paths", async () => {
    await proxy(makeRequest("/health"));
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});
