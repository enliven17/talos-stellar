/**
 * Regression coverage for API version/deprecation headers as applied by the
 * edge middleware (`src/proxy.ts`), on top of the pure unit tests in
 * `api-versioning.test.ts`.
 *
 * Focus: header propagation on every response path the middleware can take,
 * including the 429 rate-limit rejection — a path that previously skipped
 * `addVersionHeaders` entirely, so a client that got rate-limited (and would
 * naturally retry) never learned the version it hit was deprecated.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

function makeRequest(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue({
    ok: true,
    limit: 100,
    remaining: 99,
    resetAt: Date.now() + 60_000,
  });
});

describe("proxy — version headers on the allowed path", () => {
  it("adds X-API-Version to an unversioned request", async () => {
    const res = await proxy(makeRequest("/api/talos"));
    expect(res.headers.get("X-API-Version")).toBe("1");
  });

  it("adds X-API-Version and rewrites a versioned request", async () => {
    const res = await proxy(makeRequest("/api/v1/talos"));
    expect(res.headers.get("X-API-Version")).toBe("1");
  });

  it("passes through non-API paths untouched (no version header)", async () => {
    const res = await proxy(makeRequest("/health"));
    expect(res.headers.get("X-API-Version")).toBeNull();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });
});

describe("proxy — version headers on the 429 rate-limit path", () => {
  it("still carries X-API-Version when the request is rate-limited", async () => {
    rateLimitMock.mockResolvedValue({
      ok: false,
      limit: 100,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await proxy(makeRequest("/api/talos"));

    expect(res.status).toBe(429);
    expect(res.headers.get("X-API-Version")).toBe("1");
  });

  it("still carries X-API-Version for a rate-limited versioned request", async () => {
    rateLimitMock.mockResolvedValue({
      ok: false,
      limit: 100,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await proxy(makeRequest("/api/v1/talos"));

    expect(res.status).toBe(429);
    expect(res.headers.get("X-API-Version")).toBe("1");
  });
});
