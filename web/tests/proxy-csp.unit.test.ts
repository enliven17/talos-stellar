/**
 * Regression coverage for the per-request Content-Security-Policy attached
 * by the proxy (src/proxy.ts).
 *
 * Asserts on:
 *   - Report-only header present on document requests by default (all envs)
 *   - Enforce mode toggle via CSP_ENFORCE flips the header name only
 *   - Fresh per-request nonce mirrored into the request headers so Next.js
 *     server rendering can stamp it onto script tags
 *   - API responses keep their existing rate-limit/version behaviour
 *   - /api/csp-report gets its own rate-limit bucket (never the write budget)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { CSP_NONCE_HEADER } from "@/lib/security-headers.mjs";

// ─── Helpers ──────────────────────────────────────────────────────

function makeRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

function allowedResult() {
  return {
    ok: true,
    limit: 100,
    remaining: 99,
    resetAt: Date.now() + 60_000,
  };
}

/** Extract the nonce from a serialized policy. */
function nonceOf(policy: string | null): string | null {
  const match = policy?.match(/'nonce-([^']+)'/);
  return match ? match[1] : null;
}

const REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
const ENFORCE_HEADER = "Content-Security-Policy";

beforeEach(() => {
  rateLimitMock.mockReset();
  rateLimitMock.mockResolvedValue(allowedResult());

  // Deterministic policy regardless of the machine running the tests.
  vi.stubEnv("CSP_ENFORCE", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CSP_EXTRA_CONNECT_SRC", "");
  vi.stubEnv("CSP_EXTRA_IMG_SRC", "");
  vi.stubEnv("CSP_EXTRA_FRAME_SRC", "");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Document requests ────────────────────────────────────────────

describe("proxy — Content-Security-Policy on document requests", () => {
  it("sets a report-only CSP with a nonce by default", async () => {
    const res = await proxy(makeRequest("/dashboard"));

    const policy = res.headers.get(REPORT_ONLY_HEADER);
    expect(res.headers.get(ENFORCE_HEADER)).toBeNull();
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("report-to csp-endpoint");
    expect(policy).toContain("'self'");
    expect(nonceOf(policy)).toBeTruthy();
  });

  it("publishes the companion Reporting-Endpoints header", async () => {
    const res = await proxy(makeRequest("/"));

    expect(res.headers.get("Reporting-Endpoints")).toBe(
      'csp-endpoint="/api/csp-report"',
    );
  });

  it("mirrors the nonce into request headers for Next.js rendering", async () => {
    const res = await proxy(makeRequest("/dashboard"));
    const nonce = nonceOf(res.headers.get(REPORT_ONLY_HEADER));

    expect(nonce).toBeTruthy();
    expect(res.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(
      nonce,
    );
    // The renderer reads the policy from the request to find the nonce —
    // this works in report-only mode too.
    expect(res.headers.get("x-middleware-request-Content-Security-Policy")).toBe(
      res.headers.get(REPORT_ONLY_HEADER),
    );
  });

  it("mints a fresh nonce for every request", async () => {
    const first = await proxy(makeRequest("/"));
    const second = await proxy(makeRequest("/"));

    const a = nonceOf(first.headers.get(REPORT_ONLY_HEADER));
    const b = nonceOf(second.headers.get(REPORT_ONLY_HEADER));

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("switches to the enforcing header when CSP_ENFORCE is set", async () => {
    vi.stubEnv("CSP_ENFORCE", "true");

    const res = await proxy(makeRequest("/dashboard"));

    const policy = res.headers.get(ENFORCE_HEADER);
    expect(res.headers.get(REPORT_ONLY_HEADER)).toBeNull();
    // Enforcement keeps reporting so rollout violations stay observable.
    expect(policy).toContain("report-uri /api/csp-report");
    expect(nonceOf(policy)).toBeTruthy();
  });

  it("leaves the static baseline headers to next.config.mjs (no duplicates)", async () => {
    const res = await proxy(makeRequest("/"));

    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

// ─── API requests ─────────────────────────────────────────────────

describe("proxy — API behaviour is unchanged", () => {
  it("does not attach a CSP to API responses", async () => {
    const res = await proxy(makeRequest("/api/talos"));

    expect(res.headers.get(REPORT_ONLY_HEADER)).toBeNull();
    expect(res.headers.get(ENFORCE_HEADER)).toBeNull();
    expect(res.headers.get("Reporting-Endpoints")).toBeNull();
    // Version headers still flow.
    expect(res.headers.get("X-API-Version")).toBe("1");
    expect(rateLimitMock).toHaveBeenCalled();
  });

  it("rate-limits CSP reports under their own bucket, not the write budget", async () => {
    const res = await proxy(
      makeRequest("/api/csp-report", "POST", {
        "content-type": "application/csp-report",
      }),
    );

    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock.mock.calls[0][0]).toBe("csp_report:unknown");
    expect(res.headers.get("X-RateLimit-Policy")).toBe("csp-report");
  });

  it("still applies the normal read/write buckets elsewhere", async () => {
    await proxy(makeRequest("/api/talos", "GET"));
    expect(rateLimitMock.mock.calls[0][0]).toMatch(/^read:/);

    await proxy(makeRequest("/api/talos", "POST"));
    expect(rateLimitMock.mock.calls[1][0]).toMatch(/^write_ip:/);
  });
});
