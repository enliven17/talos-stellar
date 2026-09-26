/**
 * Unit tests for price and category filters on GET /api/services.
 *
 * Covers the acceptance criteria:
 *   1. minPrice / maxPrice validation (invalid, negative, empty, reversed range).
 *   2. Combined filters (category + price + sort) produce 200 and call the DB.
 *   3. minPrice === maxPrice (single-price filter) → 200.
 *   4. Clearing all filters (no params) returns the full catalogue.
 *   5. Filters compose correctly with existing cursor / limit / sort behaviour.
 *   6. DB is never queried when validation fails.
 *
 * DB and reputation ledger are fully mocked; no Postgres instance is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they are resolved before any import below them
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockReputations: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));
vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: mocks.mockReputations,
}));

import { GET as servicesGET } from "@/app/api/services/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(params: Record<string, string> = {}): NextRequest {
  const u = new URL("http://localhost/api/services");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new NextRequest(u.toString());
}

type Svc = {
  id: string;
  talosId: string;
  talosName: string;
  talosCategory: string;
  serviceName: string;
  description: null;
  price: string;
  currency: string;
  chains: string[];
  createdAt: Date;
};

function makeSvc(overrides: Partial<Svc> & { id: string; price: string }): Svc {
  return {
    talosId: `talos-${overrides.id}`,
    talosName: `Agent-${overrides.id}`,
    talosCategory: overrides.talosCategory ?? "Development",
    serviceName: `Service-${overrides.id}`,
    description: null,
    currency: "USDC",
    chains: ["stellar"],
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildChain(results: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const m of ["select","from","where","orderBy","limit","leftJoin","innerJoin","groupBy","as"]) {
    obj[m] = vi.fn(() => obj);
  }
  obj.then = vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb(results)));
  return obj;
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// 1. minPrice / maxPrice validation
// ---------------------------------------------------------------------------

describe("minPrice validation", () => {
  const invalidCases = [
    ["abc",      "non-numeric string"      ],
    ["-1",       "negative value"          ],
    ["-0.01",    "small negative decimal"  ],
    ["Infinity", "Infinity string"         ],
    ["NaN",      "NaN string"              ],
  ];

  it.each(invalidCases)(
    'rejects minPrice="%s" (%s) with 400 and no DB call',
    async (value) => {
      const res = await servicesGET(req({ minPrice: value }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toMatch(/minPrice/);
      expect(mocks.mockDb.select).not.toHaveBeenCalled();
    },
  );

  it('treats minPrice="" as absent — returns 200 without a price condition', async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ minPrice: "" }));
    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });
});

describe("maxPrice validation", () => {
  const invalidCases = [
    ["abc",      "non-numeric string"   ],
    ["-5",       "negative value"       ],
    ["NaN",      "NaN string"           ],
  ];

  it.each(invalidCases)(
    'rejects maxPrice="%s" (%s) with 400 and no DB call',
    async (value) => {
      const res = await servicesGET(req({ maxPrice: value }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/maxPrice/);
      expect(mocks.mockDb.select).not.toHaveBeenCalled();
    },
  );

  it('treats maxPrice="" as absent — returns 200 without a price condition', async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ maxPrice: "" }));
    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 2. Reversed price range
// ---------------------------------------------------------------------------

describe("reversed price range (minPrice > maxPrice)", () => {
  const reversed: Array<[string, string]> = [
    ["100",   "10"  ],
    ["50.01", "50"  ],
    ["1",     "0"   ],
  ];

  it.each(reversed)(
    "minPrice=%s > maxPrice=%s → 400 with both values in error message",
    async (min, max) => {
      const res = await servicesGET(req({ minPrice: min, maxPrice: max }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain(min);
      expect(body.error).toContain(max);
      expect(mocks.mockDb.select).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Valid single-param price filters
// ---------------------------------------------------------------------------

describe("valid single price param", () => {
  it("returns 200 for minPrice=0 (free-tier boundary)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ minPrice: "0" }));
    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });

  it("returns 200 for maxPrice=0", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ maxPrice: "0" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 for minPrice=5.99 (decimal)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ minPrice: "5.99" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 for maxPrice=999.99", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req({ maxPrice: "999.99" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. Equal min and max (single-price filter)
// ---------------------------------------------------------------------------

describe("minPrice === maxPrice (single-price filter)", () => {
  it("returns 200 and passes through matching services", async () => {
    const svc = makeSvc({ id: "exact", price: "25" });
    mocks.mockDb.select.mockReturnValue(buildChain([svc]));

    const res = await servicesGET(req({ minPrice: "25", maxPrice: "25" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].price).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// 5. Combined filters
// ---------------------------------------------------------------------------

describe("combined filters produce a single DB call with data", () => {
  it("category + minPrice + maxPrice → 200, returns matched services", async () => {
    const svc = makeSvc({ id: "mkt-1", price: "20", talosCategory: "Marketing" });
    mocks.mockDb.select.mockReturnValue(buildChain([svc]));

    const res = await servicesGET(req({
      category: "Marketing",
      minPrice: "10",
      maxPrice: "30",
    }));

    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].talosCategory).toBe("Marketing");
    expect(body.data[0].price).toBe(20);
  });

  it("category + minPrice + sort → 200", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));

    const res = await servicesGET(req({
      category: "Development",
      minPrice: "5",
      sort: "price",
      direction: "asc",
    }));

    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });

  it("maxPrice only + sort desc → 200", async () => {
    const svcs = [
      makeSvc({ id: "s1", price: "9.99" }),
      makeSvc({ id: "s2", price: "4.50" }),
    ];
    mocks.mockDb.select.mockReturnValue(buildChain(svcs));

    const res = await servicesGET(req({
      maxPrice: "10",
      sort: "price",
      direction: "desc",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("all four params together (category + minPrice + maxPrice + sort) → 200", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));

    const res = await servicesGET(req({
      category: "Analytics",
      minPrice: "1",
      maxPrice: "100",
      sort: "price",
      direction: "asc",
      limit: "10",
    }));

    expect(res.status).toBe(200);
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 6. Clearing all filters (no params at all)
// ---------------------------------------------------------------------------

describe("clearing all filters", () => {
  it("no params returns the full unfiltered catalogue with 200", async () => {
    const svcs = [
      makeSvc({ id: "a", price: "5",  talosCategory: "Marketing"   }),
      makeSvc({ id: "b", price: "50", talosCategory: "Development" }),
      makeSvc({ id: "c", price: "99", talosCategory: "Finance"     }),
    ];
    mocks.mockDb.select.mockReturnValue(buildChain(svcs));

    const res = await servicesGET(req({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
  });

  it("after clearing, no price condition is applied (DB called once)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    await servicesGET(req({}));
    expect(mocks.mockDb.select).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 7. Invalid price does not shadow earlier validated params
// ---------------------------------------------------------------------------

describe("bad price param does not execute DB query even with valid limit/sort", () => {
  it("invalid minPrice stops processing before the DB call", async () => {
    const res = await servicesGET(req({ limit: "10", sort: "price", minPrice: "bad" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("reversed range stops processing before the DB call", async () => {
    const res = await servicesGET(req({ category: "Marketing", minPrice: "50", maxPrice: "10" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Price filters compose with pagination (cursor + price range → 400 only
//    when sort is non-default; valid default sort + price → 200)
// ---------------------------------------------------------------------------

describe("price filters compose with pagination", () => {
  it("valid cursor + default sort + price range → 200", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: "svc-1" }),
      "utf8",
    ).toString("base64url");

    const res = await servicesGET(req({ cursor, minPrice: "5", maxPrice: "50" }));
    expect(res.status).toBe(200);
  });

  it("cursor + non-default sort + any price → 400 (cursor/sort conflict)", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", id: "svc-1" }),
      "utf8",
    ).toString("base64url");

    const res = await servicesGET(req({ cursor, sort: "price", minPrice: "5" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. Response shape is preserved when price filters are active
// ---------------------------------------------------------------------------

describe("response shape with active price filters", () => {
  it("returns { data, nextCursor } shape with a price filter applied", async () => {
    const svc = makeSvc({ id: "shape-1", price: "15" });
    mocks.mockDb.select.mockReturnValue(buildChain([svc]));

    const res = await servicesGET(req({ minPrice: "10", maxPrice: "20" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("nextCursor");
    expect(Array.isArray(body.data)).toBe(true);
    // price is returned as a number, not a string
    expect(typeof body.data[0].price).toBe("number");
    expect(body.data[0].price).toBe(15);
  });

  it("returns nextCursor=null when there is no second page", async () => {
    const svc = makeSvc({ id: "shape-2", price: "7" });
    mocks.mockDb.select.mockReturnValue(buildChain([svc]));

    const res = await servicesGET(req({ maxPrice: "10", limit: "5" }));
    const body = await res.json();
    // 1 result < limit 5 → no next page
    expect(body.nextCursor).toBeNull();
  });
});
