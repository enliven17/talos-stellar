/**
 * Unit tests for marketplace sort validation (issue #437).
 *
 * Covers the pure `parseMarketplaceSort` parser, the cursor-compatibility
 * guard, the deterministic orderBy builder, and route-level behaviour for
 * valid / invalid / omitted parameters. The DB is fully mocked — no live
 * marketplace dependency.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { asc, desc, sql } from "drizzle-orm";
import {
  buildMarketplaceOrderBy,
  isDefaultMarketplaceSort,
  parseMarketplaceSort,
  PLAYBOOKS_SORT_FIELDS,
  SERVICES_SORT_FIELDS,
} from "@/lib/marketplace-sort";

// ---------------------------------------------------------------------------
// Shared DB mock — every chain method returns `this` for fluent calls.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const chain = () => {
    const obj: Record<string, unknown> = {};
    const methods = [
      "select", "from", "where", "orderBy", "limit", "leftJoin",
      "innerJoin", "groupBy", "as",
    ];
    for (const m of methods) {
      obj[m] = vi.fn(() => obj);
    }
    // .then() resolves with an empty array by default
    obj.then = vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb([])));
    return obj;
  };

  return {
    mockDb: {
      select: vi.fn(() => chain()),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    },
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

// Silence reputation ledger lookups — not exercised for empty result sets.
vi.mock("@/lib/reputation-ledger", () => ({
  fetchReputations: vi.fn().mockResolvedValue(new Map()),
}));

function req(url: string, params: Record<string, string> = {}): NextRequest {
  const u = new URL(`http://localhost${url}`);
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v);
  }
  return new NextRequest(u.toString());
}

// ---------------------------------------------------------------------------
// 1. parseMarketplaceSort — pure parser (no DB / network)
// ---------------------------------------------------------------------------

describe("parseMarketplaceSort", () => {
  const servicesConfig = {
    allowedFields: SERVICES_SORT_FIELDS,
    fieldLabel: "createdAt, price",
  };

  describe("omitted parameters → deterministic defaults", () => {
    it("uses createdAt desc when both params are absent", () => {
      const result = parseMarketplaceSort(null, null, servicesConfig);
      expect(result).toEqual({
        ok: true,
        sort: { field: "createdAt", direction: "desc" },
      });
    });

    it("uses the default field when only direction is provided", () => {
      const result = parseMarketplaceSort(null, "asc", servicesConfig);
      expect(result).toEqual({
        ok: true,
        sort: { field: "createdAt", direction: "asc" },
      });
    });

    it("uses the default direction when only sort is provided", () => {
      const result = parseMarketplaceSort("price", null, servicesConfig);
      expect(result).toEqual({
        ok: true,
        sort: { field: "price", direction: "desc" },
      });
    });
  });

  describe("valid parameters → documented ordering", () => {
    const validCases: Array<[string, string, string, string]> = [
      ["createdAt", "desc", "createdAt", "desc"],
      ["createdAt", "asc", "createdAt", "asc"],
      ["price", "desc", "price", "desc"],
      ["price", "asc", "price", "asc"],
    ];
    it.each(validCases)(
      'sort="%s" direction="%s" → %s %s',
      (sort, direction, field, dir) => {
        const result = parseMarketplaceSort(sort, direction, servicesConfig);
        expect(result).toEqual({ ok: true, sort: { field, direction: dir } });
      },
    );

    it("accepts every playbook sort field", () => {
      for (const field of PLAYBOOKS_SORT_FIELDS) {
        const result = parseMarketplaceSort(field, "asc", {
          allowedFields: PLAYBOOKS_SORT_FIELDS,
          fieldLabel: "createdAt, price, title",
        });
        expect(result.ok).toBe(true);
      }
    });
  });

  describe("invalid parameters → 400 and never reach the query builder", () => {
    it.each(["bogus", "name", "id", ""])(
      'rejects unknown sort field "%s"',
      (field) => {
        const result = parseMarketplaceSort(field, null, servicesConfig);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.response.status).toBe(400);
      },
    );

    it.each(["up", "ASC", "DESC", "ascending", ""])(
      'rejects unknown direction "%s"',
      (direction) => {
        const result = parseMarketplaceSort("price", direction, servicesConfig);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.response.status).toBe(400);
      },
    );

    it("returns a human-readable error message on invalid sort", async () => {
      const result = parseMarketplaceSort("bogus", null, servicesConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body.error).toContain("Invalid sort field");
        expect(body.error).toContain("createdAt, price");
      }
    });

    it("returns a human-readable error message on invalid direction", async () => {
      const result = parseMarketplaceSort("price", "sideways", servicesConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const body = await result.response.json();
        expect(body.error).toContain("Invalid sort direction");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. isDefaultMarketplaceSort — cursor-compatibility guard
// ---------------------------------------------------------------------------

describe("isDefaultMarketplaceSort", () => {
  it("returns true for the default createdAt desc ordering", () => {
    expect(
      isDefaultMarketplaceSort({ field: "createdAt", direction: "desc" }),
    ).toBe(true);
  });

  it("returns false for every other field/direction combination", () => {
    expect(
      isDefaultMarketplaceSort({ field: "createdAt", direction: "asc" }),
    ).toBe(false);
    expect(
      isDefaultMarketplaceSort({ field: "price", direction: "desc" }),
    ).toBe(false);
    expect(
      isDefaultMarketplaceSort({ field: "price", direction: "asc" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. buildMarketplaceOrderBy — deterministic, total ordering
// ---------------------------------------------------------------------------

describe("buildMarketplaceOrderBy", () => {
  const createdAt = sql`created_at`;
  const price = sql`price`;
  const title = sql`title`;
  const id = sql`id`;

  const columns = { createdAt, price, title };

  it("keeps the default createdAt desc ordering with an id tiebreaker", () => {
    const orderBy = buildMarketplaceOrderBy(
      { field: "createdAt", direction: "desc" },
      columns,
      id,
    );
    expect(orderBy).toHaveLength(2);
    expect(orderBy[0].queryChunks).toEqual(desc(createdAt).queryChunks);
    expect(orderBy[1].queryChunks).toEqual(desc(id).queryChunks);
  });

  it("orders by the requested field and direction with a stable id tiebreaker", () => {
    const orderBy = buildMarketplaceOrderBy(
      { field: "price", direction: "asc" },
      columns,
      id,
    );
    expect(orderBy[0].queryChunks).toEqual(asc(price).queryChunks);
    expect(orderBy[1].queryChunks).toEqual(desc(id).queryChunks);

    const descTitle = buildMarketplaceOrderBy(
      { field: "title", direction: "desc" },
      columns,
      id,
    );
    expect(descTitle[0].queryChunks).toEqual(desc(title).queryChunks);
    expect(descTitle[1].queryChunks).toEqual(desc(id).queryChunks);
  });
});

// ---------------------------------------------------------------------------
// 4. GET /api/services — route-level sort validation (mocked DB)
// ---------------------------------------------------------------------------

import { GET as servicesGET } from "@/app/api/services/route";
import { GET as playbooksGET } from "@/app/api/playbooks/route";

describe("GET /api/services — sort validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with a valid sort", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req("/api/services", { sort: "price", direction: "asc" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with the default sort when parameters are omitted", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(req("/api/services"));
    expect(res.status).toBe(200);
  });

  it("returns 400 and never queries the DB for an invalid sort field", async () => {
    const res = await servicesGET(req("/api/services", { sort: "bogus" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 and never queries the DB for an invalid direction", async () => {
    const res = await servicesGET(req("/api/services", { sort: "price", direction: "up" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 when a cursor is combined with a non-default sort", async () => {
    const res = await servicesGET(
      req("/api/services", { sort: "price", cursor: "2026-08-01T00:00:00.000Z|svc-1" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("allows a cursor with the default sort", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await servicesGET(
      req("/api/services", { cursor: "2026-08-01T00:00:00.000Z|svc-1" }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /api/playbooks — route-level sort validation (mocked DB)
// ---------------------------------------------------------------------------

describe("GET /api/playbooks — sort validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with a valid sort", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await playbooksGET(req("/api/playbooks", { sort: "title", direction: "asc" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with the default sort when parameters are omitted", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await playbooksGET(req("/api/playbooks"));
    expect(res.status).toBe(200);
  });

  it("returns 400 and never queries the DB for an invalid sort field", async () => {
    const res = await playbooksGET(req("/api/playbooks", { sort: "bogus" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 and never queries the DB for an invalid direction", async () => {
    const res = await playbooksGET(req("/api/playbooks", { sort: "price", direction: "sideways" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 when a cursor is combined with a non-default sort", async () => {
    const res = await playbooksGET(
      req("/api/playbooks", { sort: "price", cursor: "2026-08-01T00:00:00.000Z|pb-1" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("allows a cursor with the default sort", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await playbooksGET(
      req("/api/playbooks", { cursor: "2026-08-01T00:00:00.000Z|pb-1" }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildChain(results: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const methods = [
    "select", "from", "where", "orderBy", "limit", "leftJoin",
    "innerJoin", "groupBy", "as",
  ];
  for (const m of methods) {
    obj[m] = vi.fn(() => obj);
  }
  obj.then = vi.fn((cb: (v: unknown[]) => unknown) => Promise.resolve(cb(results)));
  return obj;
}
