import { NextRequest, NextResponse } from "next/server";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * Next.js Middleware — IP-based rate limiting for all /api routes.
 *
 * Tiers:
 *   - POST/PUT/PATCH (mutating): 30 req / 60 s per IP
 *   - GET  (read):               120 req / 60 s per IP
 *   - Auth routes (/api/talos/me, check-name): 20 req / 60 s per IP (brute-force guard)
 */

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only rate-limit API routes
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const method = request.method.toUpperCase();

  // Strict tier: auth-sensitive endpoints
  const isAuthRoute =
    pathname.endsWith("/me") ||
    pathname.includes("check-name") ||
    pathname.includes("regenerate-key");

  if (isAuthRoute) {
    const result = rateLimit(`auth:${ip}`, { limit: 20, windowMs: 60_000 });
    if (!result.ok) return rateLimitResponse(result);
    return NextResponse.next();
  }

  // Mutating requests: stricter limit
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    const result = rateLimit(`write:${ip}`, { limit: 30, windowMs: 60_000 });
    if (!result.ok) return rateLimitResponse(result);
    return NextResponse.next();
  }

  // Read requests
  const result = rateLimit(`read:${ip}`, { limit: 120, windowMs: 60_000 });
  if (!result.ok) return rateLimitResponse(result);

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
