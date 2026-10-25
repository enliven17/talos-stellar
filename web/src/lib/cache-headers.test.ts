import { describe, it, expect } from "vitest";
import {
  applyPublicCacheHeaders,
  isRequestAuthenticated,
  DEFAULT_PUBLIC_CACHE_POLICY,
} from "./cache-headers";

describe("cache-headers helper", () => {
  describe("isRequestAuthenticated", () => {
    it("returns false when Authorization header is absent", () => {
      const req = new Request("http://localhost/api/test");
      expect(isRequestAuthenticated(req)).toBe(false);
    });

    it("returns false when Authorization header is empty or only whitespace", () => {
      const req = new Request("http://localhost/api/test", {
        headers: { Authorization: "   " },
      });
      expect(isRequestAuthenticated(req)).toBe(false);
    });

    it("returns true when Authorization header is present", () => {
      const req = new Request("http://localhost/api/test", {
        headers: { Authorization: "Bearer token123" },
      });
      expect(isRequestAuthenticated(req)).toBe(true);
    });
  });

  describe("applyPublicCacheHeaders", () => {
    it("applies public cache headers with s-maxage and stale-while-revalidate for anonymous requests", () => {
      const req = new Request("http://localhost/api/test");
      const res = new Response(JSON.stringify({ ok: true }));

      applyPublicCacheHeaders(res, req);

      expect(res.headers.get("Cache-Control")).toBe(
        `public, max-age=${DEFAULT_PUBLIC_CACHE_POLICY.maxAge}, s-maxage=${DEFAULT_PUBLIC_CACHE_POLICY.sMaxAge}, stale-while-revalidate=${DEFAULT_PUBLIC_CACHE_POLICY.staleWhileRevalidate}`,
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        `public, s-maxage=${DEFAULT_PUBLIC_CACHE_POLICY.sMaxAge}, stale-while-revalidate=${DEFAULT_PUBLIC_CACHE_POLICY.staleWhileRevalidate}`,
      );
    });

    it("allows overriding cache options for anonymous requests", () => {
      const req = new Request("http://localhost/api/test");
      const res = new Response(JSON.stringify({ ok: true }));

      applyPublicCacheHeaders(res, req, {
        maxAge: 10,
        sMaxAge: 45,
        staleWhileRevalidate: 120,
      });

      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=10, s-maxage=45, stale-while-revalidate=120",
      );
      expect(res.headers.get("CDN-Cache-Control")).toBe(
        "public, s-maxage=45, stale-while-revalidate=120",
      );
    });

    it("sets private, no-store and strips CDN-Cache-Control for authenticated requests", () => {
      const req = new Request("http://localhost/api/test", {
        headers: { Authorization: "Bearer token123" },
      });
      const res = new Response(JSON.stringify({ ok: true }), {
        headers: { "CDN-Cache-Control": "public, s-maxage=60" },
      });

      applyPublicCacheHeaders(res, req);

      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    });
  });
});
