/**
 * Distributed sliding-window rate limiter.
 *
 * Backend selection (via REDIS_URL env var):
 *   • Redis   — atomic counters shared across all horizontally scaled instances
 *   • Memory  — process-local fallback (dev / test / Redis unavailable)
 *
 * Fail-open by default: if Redis is unreachable, traffic is allowed through
 * using the in-process store.  Set RATE_LIMIT_FAIL_CLOSED=true to deny
 * requests when the shared store is unavailable.
 *
 * Usage:
 *   const result = await rateLimit(ip, { limit: 60, windowMs: 60_000 });
 *   if (!result.ok) return rateLimitResponse(result);
 */

import { getRateLimitStore } from "@/lib/rate-limit-store";
import { logger } from "@/lib/logger";

export interface RateLimitOptions {
  /** Max requests allowed per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Unix milliseconds when the window resets */
  resetAt: number;
}

/**
 * Increment the counter for `key` and return whether the request is within
 * the allowed quota.  This function is async because the distributed backend
 * requires a network round-trip.
 */
export async function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): Promise<RateLimitResult> {
  const store = getRateLimitStore();

  let count: number;
  let resetAt: number;

  try {
    ({ count, resetAt } = await store.increment(key, windowMs));
  } catch (err) {
    // Last-resort safety valve: if the store itself throws unexpectedly,
    // log the error and allow the request through (fail-open).
    logger.error({ err, key }, "rate-limit: store.increment threw unexpectedly, allowing request");
    const now = Date.now();
    return { ok: true, limit, remaining: 1, resetAt: now + windowMs };
  }

  return {
    ok: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}

/** Build a 429 Response with standard rate-limit and Retry-After headers. */
export function rateLimitResponse(result: RateLimitResult): Response {
  const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000));

  return new Response(
    JSON.stringify({ error: "Too many requests" }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1_000)),
        "Retry-After": String(retryAfterSec),
      },
    },
  );
}

/** Attach rate-limit headers to an existing Response (non-mutating). */
export function applyRateLimitHeaders(
  response: Response,
  result: RateLimitResult,
): Response {
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set(
    "X-RateLimit-Reset",
    String(Math.ceil(result.resetAt / 1_000)),
  );
  return response;
}

// ─── Endpoint policy table ────────────────────────────────────────
//
// Centralised quota definitions.  Override via environment variables to
// tune limits per deployment without a code change.

export interface EndpointPolicy {
  /** Bucket key prefix written to the shared store */
  keyPrefix: string;
  limit: number;
  windowMs: number;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

export const RATE_LIMIT_POLICIES = {
  /** Sensitive auth / account-management endpoints */
  auth: {
    keyPrefix: "auth",
    limit: envInt("RATE_LIMIT_AUTH_LIMIT", 20),
    windowMs: envInt("RATE_LIMIT_AUTH_WINDOW_MS", 60_000),
  },
  /** Read (GET) endpoints per IP */
  read: {
    keyPrefix: "read",
    limit: envInt("RATE_LIMIT_READ_LIMIT", 100),
    windowMs: envInt("RATE_LIMIT_READ_WINDOW_MS", 60_000),
  },
  /** Write endpoints keyed by API key */
  writeKey: {
    keyPrefix: "write_key",
    limit: envInt("RATE_LIMIT_WRITE_KEY_LIMIT", 30),
    windowMs: envInt("RATE_LIMIT_WRITE_WINDOW_MS", 60_000),
  },
  /** Write endpoints keyed by IP (unauthenticated) */
  writeIp: {
    keyPrefix: "write_ip",
    limit: envInt("RATE_LIMIT_WRITE_IP_LIMIT", 30),
    windowMs: envInt("RATE_LIMIT_WRITE_WINDOW_MS", 60_000),
  },
} satisfies Record<string, EndpointPolicy>;
