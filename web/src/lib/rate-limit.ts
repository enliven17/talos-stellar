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
export const store = new Map<string, Window>();

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

/** Add rate-limit headers to a successful response */
export function addRateLimitHeaders(response: Response, result: RateLimitResult): Response {
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
  return response;
}

/** Extract client IP from Next.js request */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  if (realIp) {
    return realIp;
  }
  if (cfConnectingIp) {
    return cfConnectingIp;
  }
  return "unknown";
}

/**
 * Higher-order wrapper to apply rate limiting to Next.js route handlers
 * 
 * Usage:
 *   export const POST = withRateLimit(
 *     async (request) => { ... },
 *     { limit: 5, windowMs: 60 * 60 * 1000 } // 5/hour
 *   );
 */
export function withRateLimit<T extends Request, Args extends unknown[] = []>(
  handler: (request: T, ...args: Args) => Promise<Response>,
  config: RateLimitOptions,
  keyPrefix: string = "",
) {
  return async (request: T, ...args: Args): Promise<Response> => {
    const ip = getClientIp(request);
    const key = keyPrefix ? `${keyPrefix}:${ip}` : ip;
    const result = rateLimit(key, config);
    
    if (!result.ok) {
      return rateLimitResponse(result);
    }
    
    const response = await handler(request, ...args);
    return addRateLimitHeaders(response, result);
  };
}
