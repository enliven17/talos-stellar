/**
 * Unit tests for directory sort/filter validation (issue #505).
 *
 * Covers the new `parseDirectoryStatusFilter`, `parseDirectoryCategoryFilter`
 * helpers, `parseMarketplaceSort` with DIRECTORY_SORT_FIELDS, and route-level
 * behaviour for GET /api/talos. The DB is fully mocked — no live dependency.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  DIRECTORY_SORT_FIELDS,
  DIRECTORY_STATUS_FILTER,
  parseDirectoryCategoryFilter,
  parseDirectoryStatusFilter,
  parseMarketplaceSort,
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

// ---------------------------------------------------------------------------
// 1. parseDirectoryStatusFilter — pure parser
// ---------------------------------------------------------------------------

describe("parseDirectoryStatusFilter", () => {
  it("returns ok:true with null when raw is null (absent)", () => {
    const result = parseDirectoryStatusFilter(null);
    expect(result).toEqual({ ok: true, status: null });
  });

  it.each(DIRECTORY_STATUS_FILTER)('accepts valid status "%s"', (status) => {
    const result = parseDirectoryStatusFilter(status);
    expect(result).toEqual({ ok: true, status });
  });

  it("trims surrounding whitespace from the value", () => {
    const result = parseDirectoryStatusFilter("  Active  ");
    expect(result).toEqual({ ok: true, status: "Active" });
  });

  it("returns 400 for an empty string", async () => {
    const result = parseDirectoryStatusFilter("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("non-empty");
    }
  });

  it("returns 400 for a whitespace-only string", async () => {
    const result = parseDirectoryStatusFilter("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it.each(["active", "ACTIVE", "Deleted", "deleted", "unknown", "bogus"])(
    'returns 400 for unknown status "%s"',
    async (status) => {
      const result = parseDirectoryStatusFilter(status);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        const body = await result.response.json();
        expect(body.error).toContain("Invalid status filter");
        expect(body.error).toContain("Active");
        expect(body.error).toContain("Retired");
      }
    },
  );

  it("does NOT allow 'Deleted' (intentionally excluded from public filter)", () => {
    const result = parseDirectoryStatusFilter("Deleted");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. parseDirectoryCategoryFilter — pure parser
// ---------------------------------------------------------------------------

describe("parseDirectoryCategoryFilter", () => {
  it("returns ok:true with null when raw is null (absent)", () => {
    const result = parseDirectoryCategoryFilter(null);
    expect(result).toEqual({ ok: true, category: null });
  });

  it("accepts a valid non-empty category string", () => {
    const result = parseDirectoryCategoryFilter("DeFi");
    expect(result).toEqual({ ok: true, category: "DeFi" });
  });

  it("trims surrounding whitespace", () => {
    const result = parseDirectoryCategoryFilter("  analytics  ");
    expect(result).toEqual({ ok: true, category: "analytics" });
  });

  it("returns 400 for an empty string", async () => {
    const result = parseDirectoryCategoryFilter("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("non-empty");
    }
  });

  it("returns 400 for a whitespace-only string", async () => {
    const result = parseDirectoryCategoryFilter("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("accepts a category exactly 128 characters long", () => {
    const category = "a".repeat(128);
    const result = parseDirectoryCategoryFilter(category);
    expect(result).toEqual({ ok: true, category });
  });

  it("returns 400 for a category longer than 128 characters", async () => {
    const category = "a".repeat(129);
    const result = parseDirectoryCategoryFilter(category);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("128");
    }
  });

  it("accepts special characters in category", () => {
    const result = parseDirectoryCategoryFilter("AI & ML");
    expect(result).toEqual({ ok: true, category: "AI & ML" });
  });
});

// ---------------------------------------------------------------------------
// 3. parseMarketplaceSort with DIRECTORY_SORT_FIELDS
// ---------------------------------------------------------------------------

describe("parseMarketplaceSort with DIRECTORY_SORT_FIELDS", () => {
  const config = {
    allowedFields: DIRECTORY_SORT_FIELDS,
    fieldLabel: "createdAt, name",
  };

  it("returns createdAt desc when both params are absent", () => {
    const result = parseMarketplaceSort(null, null, config);
    expect(result).toEqual({
      ok: true,
      sort: { field: "createdAt", direction: "desc" },
    });
  });

  it.each(DIRECTORY_SORT_FIELDS)('accepts valid sort field "%s"', (field) => {
    const result = parseMarketplaceSort(field, "asc", config);
    expect(result).toEqual({ ok: true, sort: { field, direction: "asc" } });
  });

  it("accepts 'name asc' sort", () => {
    const result = parseMarketplaceSort("name", "asc", config);
    expect(result).toEqual({ ok: true, sort: { field: "name", direction: "asc" } });
  });

  it("accepts 'name desc' sort", () => {
    const result = parseMarketplaceSort("name", "desc", config);
    expect(result).toEqual({ ok: true, sort: { field: "name", direction: "desc" } });
  });

  it("returns 400 for an unknown sort field", async () => {
    const result = parseMarketplaceSort("price", null, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("Invalid sort field");
      expect(body.error).toContain("createdAt, name");
    }
  });

  it("returns 400 for an invalid direction", async () => {
    const result = parseMarketplaceSort("createdAt", "sideways", config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toContain("Invalid sort direction");
    }
  });

  it.each(["bogus", "id", "status", ""])(
    'rejects unknown sort field "%s"',
    (field) => {
      const result = parseMarketplaceSort(field, null, config);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. GET /api/talos — route-level validation (mocked DB)
// ---------------------------------------------------------------------------

import { GET as talosGET } from "@/app/api/talos/route";

describe("GET /api/talos — sort validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with no params (defaults applied)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos"));
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid sort=createdAt direction=asc", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { sort: "createdAt", direction: "asc" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid sort=name direction=desc", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { sort: "name", direction: "desc" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 and never queries DB for an invalid sort field", async () => {
    const res = await talosGET(req("/api/talos", { sort: "bogus" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 and never queries DB for an invalid direction", async () => {
    const res = await talosGET(req("/api/talos", { sort: "name", direction: "up" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 when cursor is combined with non-default sort", async () => {
    const res = await talosGET(
      req("/api/talos", { sort: "name", cursor: "2026-08-01T00:00:00.000Z|talos-1" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("allows cursor with default sort (createdAt desc)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(
      req("/api/talos", { cursor: "2026-08-01T00:00:00.000Z|talos-1" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/talos — status filter validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with valid status=Active", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { status: "Active" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid status=Retired", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { status: "Retired" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 and never queries DB for an invalid status", async () => {
    const res = await talosGET(req("/api/talos", { status: "Deleted" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty status string", async () => {
    const res = await talosGET(req("/api/talos", { status: "" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown status value", async () => {
    const res = await talosGET(req("/api/talos", { status: "unknown" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 200 when status is absent (no filter)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/talos — category filter validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with a valid category param", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { category: "DeFi" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 for an empty category string", async () => {
    const res = await talosGET(req("/api/talos", { category: "" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for a category longer than 128 chars", async () => {
    const res = await talosGET(req("/api/talos", { category: "a".repeat(129) }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 200 when category is absent (no filter)", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/talos — minScore and minConfidence validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with valid numeric minScore", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { minScore: "0.5" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 with valid numeric minConfidence", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos", { minConfidence: "0.8" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 for NaN minScore", async () => {
    const res = await talosGET(req("/api/talos", { minScore: "not-a-number" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("minScore");
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for NaN minConfidence", async () => {
    const res = await talosGET(req("/api/talos", { minConfidence: "not-a-number" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("minConfidence");
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for Infinity minScore", async () => {
    const res = await talosGET(req("/api/talos", { minScore: "Infinity" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("returns 400 for -Infinity minConfidence", async () => {
    const res = await talosGET(req("/api/talos", { minConfidence: "-Infinity" }));
    expect(res.status).toBe(400);
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });
});

describe("GET /api/talos — combined valid params", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with all valid params combined", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(
      req("/api/talos", {
        sort: "name",
        direction: "asc",
        status: "Active",
        category: "DeFi",
        minScore: "0.6",
        minConfidence: "0.7",
        allowColdStart: "false",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 response has data and nextCursor fields", async () => {
    mocks.mockDb.select.mockReturnValue(buildChain([]));
    const res = await talosGET(req("/api/talos"));
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("nextCursor");
    expect(Array.isArray(body.data)).toBe(true);
  });
});
