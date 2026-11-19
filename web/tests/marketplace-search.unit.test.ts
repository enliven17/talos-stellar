import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

import { GET, OPTIONS } from "@/app/api/marketplace/search/route";
import {
  searchMarketplaceItems,
  getCapabilityFilters,
} from "@/lib/db/services/marketplace";

function createQueryChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  const methods = [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "groupBy",
    "innerJoin",
    "leftJoin",
  ];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.then = vi.fn((resolve: (val: unknown) => unknown) =>
    Promise.resolve(resolve(resolvedValue))
  );
  return chain;
}

function mockDbResponses(steps: unknown[]) {
  mocks.mockDb.select.mockReset();
  for (const step of steps) {
    mocks.mockDb.select.mockReturnValueOnce(createQueryChain(step));
  }
  // Default fallback if more select calls occur
  mocks.mockDb.select.mockReturnValue(createQueryChain([]));
}

function req(params: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost/api/marketplace/search");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url.toString());
}

describe("Marketplace Search API & Service", () => {
  const mockCapability = {
    id: "cap-uuid-1",
    name: "Automated Trading",
    description: "Executes automated trades on Stellar DEX",
    category: "Finance",
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  const mockItem = {
    id: "item-uuid-1",
    title: "Stellar Arbitrage Bot",
    description: "High-frequency arbitrage bot across Soroban pools",
    price: 50,
    currency: "USD",
    provider: "Talos Labs",
    rating: 5,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Text query search", () => {
    it("returns matching items by text query with count and filters", async () => {
      // 1: results, 2: count, 3: capabilities in getCapabilityFilters
      mockDbResponses([[mockItem], [{ count: 1 }], [mockCapability]]);

      const request = req({ q: "Arbitrage" });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.total).toBe(1);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(20);
      expect(data.results).toHaveLength(1);
      expect(data.results[0]).toEqual({
        id: "item-uuid-1",
        title: "Stellar Arbitrage Bot",
        description: "High-frequency arbitrage bot across Soroban pools",
        capabilities: [],
        price: 50,
        currency: "USD",
        provider: "Talos Labs",
        rating: 5,
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      expect(data.filters.capabilities).toHaveLength(1);
      expect(data.filters.capabilities[0]).toEqual({
        id: "cap-uuid-1",
        name: "Automated Trading",
        description: "Executes automated trades on Stellar DEX",
        category: "Finance",
        isActive: true,
      });
    });
  });

  describe("Capability filter search", () => {
    it("filters items by capability ID", async () => {
      // 1: itemIds, 2: items by id, 3: count, 4: capabilities list
      mockDbResponses([
        [{ id: "item-uuid-1" }],
        [mockItem],
        [{ count: 1 }],
        [mockCapability],
      ]);

      const request = req({ capabilities: JSON.stringify(["cap-uuid-1"]) });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.total).toBe(1);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].id).toBe("item-uuid-1");
    });

    it("handles capability filter when no item matches the capability", async () => {
      // 1: itemIds empty, 2: capabilities list
      mockDbResponses([[], [mockCapability]]);

      const request = req({ capabilities: JSON.stringify(["cap-nonexistent"]) });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.total).toBe(0);
      expect(data.results).toEqual([]);
      expect(data.filters.capabilities).toHaveLength(1);
    });
  });

  describe("Empty result", () => {
    it("returns empty results when query matches no items", async () => {
      // 1: results empty, 2: count 0, 3: capabilities list
      mockDbResponses([[], [{ count: 0 }], [mockCapability]]);

      const request = req({ q: "NonExistentTerm" });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.total).toBe(0);
      expect(data.results).toEqual([]);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(20);
      expect(data.filters.capabilities).toHaveLength(1);
    });
  });

  describe("Pagination and limits", () => {
    it("respects custom page and limit query parameters", async () => {
      mockDbResponses([[mockItem], [{ count: 25 }], [mockCapability]]);

      const request = req({ page: "3", limit: "10" });
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.page).toBe(3);
      expect(data.limit).toBe(10);
      expect(data.total).toBe(25);
    });
  });

  describe("OPTIONS and error handling", () => {
    it("handles OPTIONS request with status 200", async () => {
      const response = await OPTIONS();
      expect(response.status).toBe(200);
    });

    it("returns 500 when database fails", async () => {
      mocks.mockDb.select.mockImplementation(() => {
        throw new Error("DB connection error");
      });

      const request = req({ q: "error" });
      const response = await GET(request);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data).toEqual({ error: "Internal server error" });
    });
  });

  describe("Direct Service functions", () => {
    it("getCapabilityFilters returns mapped filters", async () => {
      mockDbResponses([[mockCapability]]);
      const filters = await getCapabilityFilters();
      expect(filters).toEqual([
        {
          id: "cap-uuid-1",
          name: "Automated Trading",
          description: "Executes automated trades on Stellar DEX",
          category: "Finance",
          isActive: true,
        },
      ]);
    });

    it("searchMarketplaceItems maps results correctly", async () => {
      mockDbResponses([[mockItem], [{ count: 1 }], [mockCapability]]);
      const response = await searchMarketplaceItems("Stellar", [], 1, 10);
      expect(response.total).toBe(1);
      expect(response.results[0].title).toBe("Stellar Arbitrage Bot");
    });
  });
});
