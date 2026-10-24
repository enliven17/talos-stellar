import { NextRequest, NextResponse } from "next/server";

export interface PublicCachePolicyOptions {
  /**
   * Browser / client cache duration in seconds.
   * Default: 0 (or not specified / short).
   */
  maxAge?: number;
  /**
   * Shared cache / CDN cache duration in seconds (s-maxage).
   * Default: 30 seconds.
   */
  sMaxAge?: number;
  /**
   * Allowed duration in seconds to serve stale content while revalidating.
   * Default: 60 seconds.
   */
  staleWhileRevalidate?: number;
}

export const DEFAULT_PUBLIC_CACHE_POLICY: Required<PublicCachePolicyOptions> = {
  maxAge: 0,
  sMaxAge: 30,
  staleWhileRevalidate: 60,
};

/**
 * Checks whether an incoming request includes authentication credentials.
 * If the Authorization header is present, the request is considered authenticated.
 */
export function isRequestAuthenticated(
  request: Pick<Request | NextRequest, "headers">,
): boolean {
  const authHeader = request.headers.get("authorization");
  return authHeader !== null && authHeader.trim().length > 0;
}

/**
 * Applies cache control headers for public endpoints.
 *
 * Requirements:
 * - Anonymous requests receive CDN-friendly caching with short s-maxage and stale-while-revalidate.
 * - Authenticated requests (with Authorization header) receive `private, no-store`.
 *
 * @param response The response to attach headers to.
 * @param request The incoming request to check for authorization.
 * @param options Optional custom maxAge, sMaxAge, and staleWhileRevalidate.
 */
export function applyPublicCacheHeaders<T extends Response | NextResponse>(
  response: T,
  request: Pick<Request | NextRequest, "headers">,
  options?: PublicCachePolicyOptions,
): T {
  if (isRequestAuthenticated(request)) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.delete("CDN-Cache-Control");
    return response;
  }

  const sMaxAge = options?.sMaxAge ?? DEFAULT_PUBLIC_CACHE_POLICY.sMaxAge;
  const swr =
    options?.staleWhileRevalidate ??
    DEFAULT_PUBLIC_CACHE_POLICY.staleWhileRevalidate;
  const maxAge = options?.maxAge ?? DEFAULT_PUBLIC_CACHE_POLICY.maxAge;

  const cacheControlValue = `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;
  const cdnCacheControlValue = `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;

  response.headers.set("Cache-Control", cacheControlValue);
  response.headers.set("CDN-Cache-Control", cdnCacheControlValue);

  return response;
}

/**
 * Convenience helper to create a JSON response with public cache headers applied.
 */
export function jsonWithCache(
  data: any,
  request: Pick<Request | NextRequest, "headers">,
  init?: ResponseInit,
  options?: PublicCachePolicyOptions,
): Response {
  const response = Response.json(data, init);
  return applyPublicCacheHeaders(response, request, options);
}
