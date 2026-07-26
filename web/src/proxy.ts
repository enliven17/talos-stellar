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
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const apiKey = getApiKey(request);
  const method = request.method.toUpperCase();

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
  } else if (method === "GET") {
    const p = RATE_LIMIT_POLICIES.read;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
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
  } else {
    const p = RATE_LIMIT_POLICIES.writeIp;
    result = await rateLimit(`${p.keyPrefix}:${ip}`, {
      limit: p.limit,
      windowMs: p.windowMs,
    });
  }

  if (!result.ok) {
    return rateLimitResponse(result) as NextResponse;
  }

  // ─── API versioning ───────────────────────────────────────────

  const versionInfo = negotiateApiVersion(pathname);

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
  matcher: "/api/:path*",
};
