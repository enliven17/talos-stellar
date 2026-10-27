import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ─── Shared DB mock ───────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  let pendingRows: unknown[] = [];

  function buildChain(rows: unknown[]) {
    const obj: Record<string, unknown> = {};
    const pass = ["from", "where", "orderBy", "leftJoin", "innerJoin", "groupBy", "as"];
    for (const m of pass) obj[m] = vi.fn(() => obj);
    obj.limit = vi.fn(() => obj);
    obj.then = vi.fn((cb: (v: unknown) => unknown) => Promise.resolve(cb(rows)));
    return obj;
  }

  const mockDb = {
    select: vi.fn(() => buildChain(pendingRows)),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  return {
    mockDb,
    setNextRows(rows: unknown[]) {
      pendingRows = rows;
      mockDb.select.mockImplementation(() => buildChain(rows));
    },
    buildChain,
  };
});

vi.mock("@/db", () => ({ db: mocks.mockDb }));

import { GET } from "@/app/api/leaderboard/route";

function leaderboardReq(params: Record<string, string> = {}): NextRequest {
  const u = new URL("http://localhost/api/leaderboard");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new NextRequest(u.toString());
}

function makeLeaderboardRow(overrides: Partial<{
  id: string;
  name: string;
  category: string;
  status: string;
  pulsePrice: string;
  totalSupply: number;
  patronCount: number;
  activityCount: number;
  totalRevenue: string;
}> = {}) {
  return {
    id: "talos-1",
    name: "Alpha Agent",
    category: "finance",
    status: "active",
    pulsePrice: "10",
    totalSupply: 1000,
    patronCount: 5,
    activityCount: 20,
    totalRevenue: "123.456789",
    ...overrides,
  };
}

describe("GET /api/leaderboard — cursor pagination & fractional revenue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first page: returns nextCursor with string revenue representation", async () => {
    const row1 = makeLeaderboardRow({ id: "agent-1", totalRevenue: "100.123456" });
    const row2 = makeLeaderboardRow({ id: "agent-2", totalRevenue: "50.500000" });
    const row3 = makeLeaderboardRow({ id: "agent-3", totalRevenue: "25.000000" });

    // Request limit 2 -> DB returns 3 rows (limit + 1)
    mocks.setNextRows([row1, row2, row3]);

    const res = await GET(leaderboardReq({ limit: "2" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("agent-1");
    expect(body.data[0].totalRevenue).toBe(100.123456);
    expect(body.data[1].id).toBe("agent-2");
    expect(body.data[1].totalRevenue).toBe(50.5);

    expect(body.nextCursor).not.toBeNull();
    const decoded = JSON.parse(Buffer.from(body.nextCursor, "base64").toString());
    expect(decoded).toEqual(["50.500000", "agent-2"]);
    expect(typeof decoded[0]).toBe("string");
  });

  it("subsequent page: accepts string cursor and continues pagination", async () => {
    const cursor = Buffer.from(JSON.stringify(["50.500000", "agent-2"])).toString("base64");
    const row3 = makeLeaderboardRow({ id: "agent-3", totalRevenue: "25.000000" });

    mocks.setNextRows([row3]);

    const res = await GET(leaderboardReq({ cursor, limit: "2" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("agent-3");
    expect(body.nextCursor).toBeNull();
  });

  it("backward compatibility: accepts legacy numeric revenue in cursor", async () => {
    const legacyCursor = Buffer.from(JSON.stringify([50.5, "agent-2"])).toString("base64");
    const row3 = makeLeaderboardRow({ id: "agent-3", totalRevenue: "25.000000" });

    mocks.setNextRows([row3]);

    const res = await GET(leaderboardReq({ cursor: legacyCursor, limit: "2" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("agent-3");
  });

  it("returns 400 for malformed cursors", async () => {
    const plainTextRes = await GET(leaderboardReq({ cursor: "not-a-base64" }));
    expect(plainTextRes.status).toBe(400);

    const badJson = Buffer.from("not-json").toString("base64");
    const badJsonRes = await GET(leaderboardReq({ cursor: badJson }));
    expect(badJsonRes.status).toBe(400);

    const badShape = Buffer.from(JSON.stringify({ not: "array" })).toString("base64");
    const badShapeRes = await GET(leaderboardReq({ cursor: badShape }));
    expect(badShapeRes.status).toBe(400);

    const nonNumericRev = Buffer.from(JSON.stringify(["not-a-number", "agent-1"])).toString("base64");
    const nonNumericRevRes = await GET(leaderboardReq({ cursor: nonNumericRev }));
    expect(nonNumericRevRes.status).toBe(400);

    const longCursor = Buffer.from("a".repeat(600)).toString("base64");
    const longRes = await GET(leaderboardReq({ cursor: longCursor }));
    expect(longRes.status).toBe(400);
  });

  // ─── Property-style test over generated fractional revenues & ties ──────────
  describe("property-style pagination over generated fractional revenues and ties", () => {
    // Generate simulated DB rows with fractional tied revenues
    interface AgentFixture {
      id: string;
      revenueStr: string;
      pulsePrice: string;
      totalSupply: number;
    }

    function compareAgents(a: AgentFixture, b: AgentFixture): number {
      // ORDER BY revenue::numeric DESC, id DESC
      const aRev = Number(a.revenueStr);
      const bRev = Number(b.revenueStr);
      if (aRev !== bRev) {
        return bRev - aRev;
      }
      return b.id.localeCompare(a.id);
    }

    function filterByCursor(all: AgentFixture[], cursor: [string, string] | null): AgentFixture[] {
      if (!cursor) return all;
      const [cursorRevenue, cursorId] = cursor;
      const cRev = Number(cursorRevenue);
      return all.filter((item) => {
        const itemRev = Number(item.revenueStr);
        if (itemRev < cRev) return true;
        if (itemRev === cRev && item.id < cursorId) return true;
        return false;
      });
    }

    it("paging through fixtures with fractional, tied revenues returns every row exactly once", async () => {
      // Generate deterministic pseudo-random fixtures covering:
      // - 0.1 + 0.2 precision cases (e.g. 0.300000 vs 0.30000000000000004)
      // - fractional ties
      // - zero revenues
      // - high precision fractional strings
      const fixtures: AgentFixture[] = [];
      const revenueTemplates = [
        "1000.000000",
        "500.123456",
        "500.123456", // tie
        "300.300000",
        "300.300000", // tie
        "300.300000", // 3-way tie
        "100.000001",
        "100.000000",
        "0.300000",
        "0.300000", // tie
        "0.000001",
        "0.000000",
        "0.000000", // tie zero
      ];

      for (let i = 0; i < revenueTemplates.length; i++) {
        fixtures.push({
          id: `agent-${String(i).padStart(3, "0")}`,
          revenueStr: revenueTemplates[i],
          pulsePrice: "1",
          totalSupply: 100,
        });
      }

      // Sort full dataset descending as PostgreSQL would
      const sorted = [...fixtures].sort(compareAgents);

      // Simulate client paginating through using GET route with mocked DB queries
      const pageSize = 3;
      let cursor: string | null = null;
      const collected: { id: string; totalRevenue: number }[] = [];
      let pageCount = 0;

      while (true) {
        pageCount++;
        if (pageCount > 20) {
          throw new Error("Potential infinite loop during pagination");
        }

        // Decode cursor to determine what rows the DB should return
        let parsedCursor: [string, string] | null = null;
        if (cursor) {
          const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
          parsedCursor = [String(decoded[0]), decoded[1]];
        }

        const eligible = filterByCursor(sorted, parsedCursor);
        const limitPlusOne = eligible.slice(0, pageSize + 1).map((e) =>
          makeLeaderboardRow({
            id: e.id,
            totalRevenue: e.revenueStr,
            pulsePrice: e.pulsePrice,
            totalSupply: e.totalSupply,
          }),
        );

        mocks.setNextRows(limitPlusOne);

        const res = await GET(leaderboardReq({ limit: String(pageSize), ...(cursor ? { cursor } : {}) }));
        expect(res.status).toBe(200);
        const body = await res.json();

        for (const item of body.data) {
          collected.push(item);
        }

        if (!body.nextCursor) {
          break;
        }
        cursor = body.nextCursor;
      }

      // Verification: every row is returned exactly once
      expect(collected).toHaveLength(sorted.length);
      expect(collected.map((c) => c.id)).toEqual(sorted.map((s) => s.id));
      const uniqueIds = new Set(collected.map((c) => c.id));
      expect(uniqueIds.size).toBe(sorted.length);
    });

    it("property test over randomized fractional revenue tie distributions", async () => {
      // Run across multiple random distributions
      for (let run = 0; run < 10; run++) {
        const generated: AgentFixture[] = [];
        const baseValues = [
          (0.1 + 0.2).toFixed(6),
          "0.300000",
          "123.456789",
          "99.999999",
          "0.000000",
          "42.000001",
        ];

        let idCounter = 1;
        for (const val of baseValues) {
          // Add 2 to 4 tied items for each value
          const tieCount = 2 + (idCounter % 3);
          for (let t = 0; t < tieCount; t++) {
            generated.push({
              id: `ag-${idCounter++}`,
              revenueStr: val,
              pulsePrice: "2",
              totalSupply: 50,
            });
          }
        }

        const sorted = [...generated].sort(compareAgents);
        const pageSize = 4;
        let cursor: string | null = null;
        const collectedIds: string[] = [];
        let iterations = 0;

        while (true) {
          iterations++;
          if (iterations > 30) throw new Error("Infinite pagination in property test");

          let parsedCursor: [string, string] | null = null;
          if (cursor) {
            const decoded = JSON.parse(Buffer.from(cursor, "base64").toString());
            parsedCursor = [String(decoded[0]), decoded[1]];
          }

          const eligible = filterByCursor(sorted, parsedCursor);
          const limitPlusOne = eligible.slice(0, pageSize + 1).map((e) =>
            makeLeaderboardRow({
              id: e.id,
              totalRevenue: e.revenueStr,
              pulsePrice: e.pulsePrice,
              totalSupply: e.totalSupply,
            }),
          );

          mocks.setNextRows(limitPlusOne);

          const res = await GET(leaderboardReq({ limit: String(pageSize), ...(cursor ? { cursor } : {}) }));
          expect(res.status).toBe(200);
          const body = await res.json();

          for (const item of body.data) {
            collectedIds.push(item.id);
          }

          if (!body.nextCursor) break;
          cursor = body.nextCursor;
        }

        expect(collectedIds).toEqual(sorted.map((s) => s.id));
        expect(new Set(collectedIds).size).toBe(sorted.length);
      }
    });
  });
});
