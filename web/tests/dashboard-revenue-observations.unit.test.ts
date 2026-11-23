import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const dbSelect = vi.fn();
  const dbFindMany = vi.fn();
  return { dbSelect, dbFindMany };
});

vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
    query: { tlsTalos: { findMany: mocks.dbFindMany } },
  },
}));

import { GET } from "@/app/api/dashboard/route";

function mockTalosRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "AlphaAgent",
    status: "Active",
    pulsePrice: "10",
    totalSupply: 100,
    approvalThreshold: 1000,
    gtmBudget: 5000,
    channels: ["web"],
    stellarAssetCode: "ALPHA",
    agentWalletAddress: "GALPHA",
    apiKey: null,
    agentOnline: true,
    agentLastSeen: new Date(),
    approvals: [],
    activities: [],
    revenues: [],
    patrons: [],
    ...overrides,
  };
}

async function getDashboard(rows: unknown[]) {
  mocks.dbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([]),
      }),
    }),
  }));
  mocks.dbFindMany.mockResolvedValue(rows);

  const req = new NextRequest("http://localhost/api/dashboard?wallet=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
  const res = await GET(req);
  return { res, body: await res.json() };
}

describe("GET /api/dashboard revenue uncertainty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a missing aggregate instead of $0.00 when no revenue was observed", async () => {
    const { res, body } = await getDashboard([mockTalosRow()]);

    expect(res.status).toBe(200);
    expect(body.stats.totalRevenue).toBeNull();
    expect(body.revenueStreams).toEqual([]);
  });

  it("keeps a verified zero observation distinct from missing data", async () => {
    const { body } = await getDashboard([
      mockTalosRow({
        revenues: [
          {
            amount: "0",
            source: "jobs",
            currency: "USDC",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      }),
    ]);

    expect(body.stats.totalRevenue).toBe("$0.00");
    expect(body.revenueStreams).toHaveLength(1);
    expect(body.revenueStreams[0]).toMatchObject({
      talosId: "t1",
      totalRevenue: 0,
      observationCount: 1,
      bySource: { jobs: 0 },
    });
  });

  it("sums observed revenue and groups it by source", async () => {
    const { body } = await getDashboard([
      mockTalosRow({
        revenues: [
          {
            amount: "10.50",
            source: "jobs",
            currency: "USDC",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            amount: "2",
            source: "tips",
            currency: "USDC",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ],
      }),
    ]);

    expect(body.stats.totalRevenue).toBe("$12.50");
    expect(body.revenueStreams[0]).toMatchObject({
      totalRevenue: 12.5,
      observationCount: 2,
      bySource: { jobs: 10.5, tips: 2 },
    });
  });
});
