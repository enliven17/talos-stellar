/**
 * Unit tests for GET /api/services filter validation.
 *
 * These tests call the route handler directly (no running server needed)
 * and mock the DB so they run instantly in CI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── DB mock ────────────────────────────────────────────────────────────────
// Must be hoisted before the route import so the module resolver picks it up.
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
}));

import { GET } from "../src/app/api/services/route";

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/services");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

describe("GET /api/services — filter validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with no filters", async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 400 for non-numeric minPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "abc" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/minPrice/);
  });

  it("returns 400 for non-numeric maxPrice", async () => {
    const res = await GET(makeRequest({ maxPrice: "xyz" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maxPrice/);
  });

  it("returns 400 for negative minPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-negative/);
  });

  it("returns 400 when minPrice > maxPrice (reversed range)", async () => {
    const res = await GET(makeRequest({ minPrice: "10", maxPrice: "5" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/minPrice cannot be greater/);
  });

  it("returns 200 when minPrice === maxPrice (exact price match)", async () => {
    const res = await GET(makeRequest({ minPrice: "5", maxPrice: "5" }));
    expect(res.status).toBe(200);
  });

  it("accepts valid price range", async () => {
    const res = await GET(makeRequest({ minPrice: "1", maxPrice: "100" }));
    expect(res.status).toBe(200);
  });

  it("accepts minPrice without maxPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "2.5" }));
    expect(res.status).toBe(200);
  });

  it("accepts maxPrice without minPrice", async () => {
    const res = await GET(makeRequest({ maxPrice: "50" }));
    expect(res.status).toBe(200);
  });

  it("falls back to 'newest' for an unknown sortBy value", async () => {
    // Should not return 400 — unknown values silently default to newest
    const res = await GET(makeRequest({ sortBy: "invalid_sort" }));
    expect(res.status).toBe(200);
  });

  it("accepts all valid sortBy values", async () => {
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const res = await GET(makeRequest({ sortBy: sort }));
      expect(res.status).toBe(200);
    }
  });

  it("combines category + price range + sort", async () => {
    const res = await GET(
      makeRequest({ category: "Analytics", minPrice: "1", maxPrice: "50", sortBy: "price_asc" }),
    );
    expect(res.status).toBe(200);
  });

  it("returns empty data array when no services match", async () => {
    const res = await GET(makeRequest({ minPrice: "99999" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it("nextCursor is null for price-sorted responses", async () => {
    const res = await GET(makeRequest({ sortBy: "price_asc" }));
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
  });
});
