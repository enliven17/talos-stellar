import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimitHeaders,
  rateLimit,
  rateLimitResponse,
  RateLimitResult,
} from "@/lib/rate-limit";

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function getApiKey(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7).trim();
  }
  return null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only rate-limit API routes
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const ip = getClientIp(request);
  const apiKey = getApiKey(request);
  const method = request.method.toUpperCase();

  // Strict tier: auth-sensitive endpoints
  const isAuthRoute =
    pathname.endsWith("/me") ||
    pathname.includes("check-name") ||
    pathname.includes("regenerate-key");

  let result: RateLimitResult;

  if (isAuthRoute) {
    result = rateLimit(`auth:${ip}`, { limit: 20, windowMs: 60_000 });
  } else if (method === "GET") {
    result = rateLimit(`read:${ip}`, { limit: 100, windowMs: 60_000 });
  } else if (method === "POST" && apiKey) {
    result = rateLimit(`write_key:${apiKey}`, {
      limit: 30,
      windowMs: 60_000,
    });
  } else {
    result = rateLimit(`write_ip:${ip}`, {
      limit: 30,
      windowMs: 60_000,
    });
  }

  if (!result.ok) {
    return rateLimitResponse(result);
  }

  return applyRateLimitHeaders(NextResponse.next(), result);
}

export const config = {
  matcher: "/api/:path*",
};