/**
 * Unit tests for GET /api/services — price range filter validation.
 *
 * Upstream already covers sort/direction via web/tests/marketplace-sort.unit.test.ts.
 * These tests focus exclusively on the minPrice/maxPrice params added by this PR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

vi.mock("@/lib/marketplace-sort", () => ({
  parseMarketplaceSort: vi.fn().mockReturnValue({ ok: true, sort: { field: "createdAt", direction: "desc" } }),
  isDefaultMarketplaceSort: vi.fn().mockReturnValue(true),
  buildMarketplaceOrderBy: vi.fn().mockReturnValue([]),
  SERVICES_SORT_FIELDS: ["createdAt", "price"],
}));

vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/tracing", () => ({
  withTraceContext: (fn: unknown) => fn,
}));

vi.mock("@/lib/parse-limit", () => ({
  parseLimit: vi.fn().mockReturnValue({ ok: true, limit: 50 }),
}));

import { GET } from "../src/app/api/services/route";

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/services");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/services — price range validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with no price filters", async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 400 for non-numeric minPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/minPrice/);
  });

  it("returns 400 for non-numeric maxPrice", async () => {
    const res = await GET(makeRequest({ maxPrice: "xyz" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/maxPrice/);
  });

  it("returns 400 for negative minPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/non-negative/);
  });

  it("returns 400 when minPrice > maxPrice (reversed range)", async () => {
    const res = await GET(makeRequest({ minPrice: "10", maxPrice: "5" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/minPrice cannot be greater/);
  });

  it("returns 200 when minPrice === maxPrice (exact match)", async () => {
    const res = await GET(makeRequest({ minPrice: "5", maxPrice: "5" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 for valid price range", async () => {
    const res = await GET(makeRequest({ minPrice: "1", maxPrice: "100" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with only minPrice", async () => {
    const res = await GET(makeRequest({ minPrice: "2.5" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with only maxPrice", async () => {
    const res = await GET(makeRequest({ maxPrice: "50" }));
    expect(res.status).toBe(200);
  });

  it("combines category + price range", async () => {
    const res = await GET(makeRequest({ category: "Analytics", minPrice: "1", maxPrice: "50" }));
    expect(res.status).toBe(200);
  });
});
