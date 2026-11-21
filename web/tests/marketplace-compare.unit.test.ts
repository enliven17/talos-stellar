import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as compareRoute } from "../src/app/api/marketplace/compare/route";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  _dbSelectResults: [] as any[],
  _dbSelectCallCount: 0,
}));

vi.mock("drizzle-orm", () => ({
  inArray: vi.fn(),
}));

vi.mock("@/db/schema", () => ({
  marketplaceItems: {
    id: "id",
  },
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => {
      const callIndex = mocks._dbSelectCallCount++;
      const row = mocks._dbSelectResults[callIndex] ?? [];
      const chain: any = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: (rows: any[]) => any) => cb(row)),
      };
      return chain;
    }),
  },
}));

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks._dbSelectCallCount = 0;
  mocks._dbSelectResults = [];
});

// Helper: reset DB select sequence and enqueue results per call index
function setupDbSelects(...rows: Array<any[] | null>) {
  mocks._dbSelectCallCount = 0;
  mocks._dbSelectResults = rows.map((r) => r ?? []);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GET /api/marketplace/compare", () => {
  it("returns 400 when missing ids parameter", async () => {
    const res = await compareRoute(new NextRequest("http://localhost/api/marketplace/compare"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids parameter is empty", async () => {
    const res = await compareRoute(new NextRequest("http://localhost/api/marketplace/compare?ids="));
    expect(res.status).toBe(400);
  });

  it("returns 400 when too many ids are provided", async () => {
    const ids = Array(11).fill("id").join(",");
    const res = await compareRoute(new NextRequest(`http://localhost/api/marketplace/compare?ids=${ids}`));
    expect(res.status).toBe(400);
  });

  it("returns items when valid ids are provided", async () => {
    const mockItems = [
      {
        id: "id1",
        title: "Title 1",
        description: "Desc 1",
        price: 100,
        currency: "USD",
        provider: "Prov 1",
        rating: 5,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    setupDbSelects(mockItems);

    const res = await compareRoute(new NextRequest("http://localhost/api/marketplace/compare?ids=id1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("id1");
    expect(body.items[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
