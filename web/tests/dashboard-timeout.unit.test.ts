import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const dbSelect = vi.fn();
  const dbFindMany = vi.fn();

  return { dbSelect, dbFindMany };
});

vi.mock("@/db", () => ({
  db: {
    select: mocks.dbSelect,
    query: {
      tlsTalos: {
        findMany: mocks.dbFindMany,
      },
    },
  },
}));

import { GET, DASHBOARD_QUERY_TIMEOUT_MS } from "@/app/api/dashboard/route";

describe("GET /api/dashboard timeout handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a DASHBOARD_QUERY_TIMEOUT_MS constant under 25s", () => {
    expect(DASHBOARD_QUERY_TIMEOUT_MS).toBeDefined();
    expect(DASHBOARD_QUERY_TIMEOUT_MS).toBeLessThan(25_000);
    expect(DASHBOARD_QUERY_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns 504 with standard envelope when patron query times out (never-resolving mock + fake timers)", async () => {
    // A query that never resolves
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => new Promise(() => {}),
        }),
      }),
    }));

    const req = new NextRequest("http://localhost/api/dashboard?wallet=GABC1234567890", {
      headers: { "x-request-id": "req-timeout-patron" },
    });

    const routePromise = GET(req);

    // Fast-forward fake timers past the dashboard query timeout
    await vi.advanceTimersByTimeAsync(DASHBOARD_QUERY_TIMEOUT_MS + 100);

    const res = await routePromise;
    expect(res.status).toBe(504);

    const body = await res.json();
    expect(body).toEqual({
      code: "GATEWAY_TIMEOUT",
      message: "Query timeout. Please try again with a simpler query.",
      requestId: "req-timeout-patron",
    });
    expect(res.headers.get("x-request-id")).toBe("req-timeout-patron");
  });

  it("returns 504 with standard envelope when main query times out (never-resolving mock + fake timers)", async () => {
    // Patron query resolves quickly with empty or non-empty list
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));

    // Main query never resolves
    mocks.dbFindMany.mockImplementation(() => new Promise(() => {}));

    const req = new NextRequest("http://localhost/api/dashboard?wallet=GABC1234567890", {
      headers: { "x-request-id": "req-timeout-main" },
    });

    const routePromise = GET(req);

    // Fast-forward fake timers past the dashboard query timeout
    await vi.advanceTimersByTimeAsync(DASHBOARD_QUERY_TIMEOUT_MS + 100);

    const res = await routePromise;
    expect(res.status).toBe(504);

    const body = await res.json();
    expect(body).toEqual({
      code: "GATEWAY_TIMEOUT",
      message: "Query timeout. Please try again with a simpler query.",
      requestId: "req-timeout-main",
    });
    expect(res.headers.get("x-request-id")).toBe("req-timeout-main");
  });

  it("returns 200 with unchanged data when queries succeed", async () => {
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ talosId: "t1" }]),
        }),
      }),
    }));

    mocks.dbFindMany.mockResolvedValue([
      {
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
        apiKey: "tak_1234567890abcdef",
        agentOnline: true,
        agentLastSeen: new Date(),
        approvals: [],
        activities: [],
        revenues: [],
        patrons: [],
      },
    ]);

    const req = new NextRequest("http://localhost/api/dashboard?wallet=GABC1234567890");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats).toBeDefined();
    expect(body.stats.activeTalos).toBe(1);
    expect(body.agents).toBeDefined();
    expect(body.talosManagement).toBeDefined();
  });
});
