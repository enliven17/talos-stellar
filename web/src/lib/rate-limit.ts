/**
 * Sliding window rate limiter.
 *
 * In-memory implementation — works for single-process (dev / single Vercel instance).
 * For multi-instance production: replace `store` with Upstash Redis.
 *
 * Usage:
 *   const result = rateLimit(ip, { limit: 60, windowMs: 60_000 });
 *   if (!result.ok) return rateLimitResponse(result);
 */

interface Window {
  count: number;
  resetAt: number;
}

// Process-local store: key → sliding window state
const store = new Map<string, Window>();

// Prune expired entries every 5 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, win] of store) {
    if (win.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

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
  resetAt: number; // Unix ms
}

export function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();
  let win = store.get(key);

  if (!win || win.resetAt < now) {
    win = { count: 1, resetAt: now + windowMs };
    store.set(key, win);
  } else {
    win.count += 1;
  }

  return {
    ok: win.count <= limit,
    limit,
    remaining: Math.max(0, limit - win.count),
    resetAt: win.resetAt,
  };
}

/** Build a 429 Response with standard rate-limit headers */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests" }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
        "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
      },
    },
  );
}
