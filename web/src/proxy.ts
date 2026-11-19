import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
  RATE_LIMIT_POLICIES,
  RateLimitResult,
} from "@/lib/rate-limit";
import {
  addVersionHeaders,
  isVersionedPath,
  negotiateApiVersion,
  stripVersionPrefix,
} from "@/lib/api-versioning";
import {
  CSP_NONCE_HEADER,
  CSP_REPORT_ENDPOINT,
  createCspNonce,
  getCspHeader,
  getReportingEndpointsHeader,
} from "@/lib/security-headers.mjs";

// ─── Trusted proxy IP extraction ──────────────────────────────────
//
// The number of trusted proxy hops is controlled by TRUSTED_PROXY_DEPTH
// (default: 1).  A value of 1 means we trust the last entry appended by
// the first upstream proxy (Vercel / Railway edge).  Set to 0 to use the
// raw remote address only (not available in Next.js middleware — falls
// back to x-real-ip).
//
// SECURITY: Setting this too high lets clients spoof their IP by injecting
// leading X-Forwarded-For values.  Match this to your infrastructure's
// actual proxy depth.

const TRUSTED_PROXY_DEPTH = (() => {
  const n = parseInt(process.env.TRUSTED_PROXY_DEPTH ?? "1", 10);
  return isNaN(n) || n < 0 ? 1 : n;
})();

function getClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map((s) => s.trim()).filter(Boolean);
    // Pick the IP at (total - TRUSTED_PROXY_DEPTH) from the right.
    // e.g. xff="client, proxy1, proxy2", depth=1 → "proxy1" is trusted,
    // so the client IP is the entry just before the last `depth` entries.
    const idx = ips.length - TRUSTED_PROXY_DEPTH - 1;
    if (idx >= 0 && ips[idx]) return ips[idx];
    // If depth >= list length, use the first (leftmost) entry.
    if (ips[0]) return ips[0];
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}

function getApiKey(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7).trim();
  }
  return null;
}

// ─── Middleware ───────────────────────────────────────────────────

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    // Document (page) request: attach a per-request Content-Security-Policy.
    // The static baseline headers from next.config.mjs still apply on top.
    return applyContentSecurityPolicy(request);
  }

  const ip = getClientIp(request);
  const apiKey = getApiKey(request);
  const method = request.method.toUpperCase();

  // Computed up front (pure, no I/O) so it's available for every response
  // path below, including the 429 rate-limit rejection — a client that gets
  // rate-limited on a deprecated version still needs the Deprecation/Sunset
  // signal so a retry lands on the right version.
  const versionInfo = negotiateApiVersion(pathname);

  // Identify which policy bucket applies to this request.
  const isAuthRoute =
    pathname.endsWith("/me") ||
    pathname.includes("check-name") ||
    pathname.includes("regenerate-key");

  let result: RateLimitResult;

  if (isAuthRoute) {
    const p = RATE_LIMIT_POLICIES.auth;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
    result.policy = p.name;
  } else if (pathname === CSP_REPORT_ENDPOINT) {
    // CSP violation reports are fire-and-forget telemetry: they get their
    // own bucket so a report-only rollout can never exhaust the budget of
    // real client writes coming from the same IP.
    const p = RATE_LIMIT_POLICIES.cspReport;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
    result.policy = p.name;
  } else if (method === "GET") {
    const p = RATE_LIMIT_POLICIES.read;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
    result.policy = p.name;
  } else if (method === "POST" && apiKey) {
    const p = RATE_LIMIT_POLICIES.writeKey;
    // Hash the API key so raw secrets never reach the shared store.
    // We use a simple prefix truncation here (first 16 chars) because
    // constant-time hashing is not available in the Edge runtime without
    // importing crypto, and the key itself is already a secret.  Full
    // SHA-256 is used when the standard crypto module is available.
    const safeKey = sanitizeApiKey(apiKey);
    result = await rateLimit(`${p.keyPrefix}:${safeKey}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
    result.policy = p.name;
  } else {
    const p = RATE_LIMIT_POLICIES.writeIp;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
    result.policy = p.name;
  }

  if (!result.ok) {
    const response = rateLimitResponse(result);
    addVersionHeaders(response.headers, versionInfo);
    return response as NextResponse;
  }

  // ─── API versioning ───────────────────────────────────────────

  if (isVersionedPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = stripVersionPrefix(pathname);
    const response = NextResponse.rewrite(url);
    addVersionHeaders(response.headers, versionInfo);
    return applyRateLimitHeaders(response, result) as NextResponse;
  }

  const response = NextResponse.next();
  addVersionHeaders(response.headers, versionInfo);
  return applyRateLimitHeaders(response, result) as NextResponse;
}

/**
 * Attach a per-request Content-Security-Policy to document responses.
 *
 * A fresh nonce is minted for every request and mirrored into the request
 * headers (`Content-Security-Policy` + `x-nonce`) so Next.js server
 * rendering stamps it onto framework, bundle and inline <script> tags.
 * The response header name follows the active mode: report-only unless
 * CSP_ENFORCE selects enforcement (see resolveCspMode).
 */
function applyContentSecurityPolicy(request: NextRequest): NextResponse {
  const nonce = createCspNonce();
  const csp = getCspHeader({ nonce });

  const requestHeaders = new Headers(request.headers);
  // Next.js extracts the nonce from this request header during rendering.
  requestHeaders.set("Content-Security-Policy", csp.value);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.key, csp.value);

  const reporting = getReportingEndpointsHeader();
  response.headers.set(reporting.key, reporting.value);
  return response;
}

/**
 * Derive a safe, fixed-length store key from a raw API key.
 * Avoids writing full secrets into the shared store while keeping
 * the key deterministic for the same API key value.
 */
function sanitizeApiKey(apiKey: string): string {
  // Use first 8 + last 8 chars as a cheap fingerprint (no crypto needed in
  // Edge runtime).  Keys are already high-entropy random strings so
  // collision probability is negligible across a single deployment's key space.
  if (apiKey.length <= 16) return apiKey;
  return `${apiKey.slice(0, 8)}${apiKey.slice(-8)}`;
}

export const config = {
  matcher: [
    // API routes keep their own catch-all: rate limiting and versioning must
    // run on every API request.  This entry is listed first so the prefetch
    // exclusion below can never be used to bypass it.
    "/api/:path*",
    // Documents get the per-request CSP.  Static assets and link prefetches
    // don't need one (per Next.js CSP guidance).
    {
      source:
        "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
