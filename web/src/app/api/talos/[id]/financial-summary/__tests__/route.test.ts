import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// ── Hoisted mocks ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  mockVerifyAgentApiKey: vi.fn(),
  mockSelect: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.mockVerifyAgentApiKey,
}));

vi.mock("@/db", () => ({
  db: {
    select: mocks.mockSelect,
  },
}));

// ── Helper: mock a Drizzle select chain ────────────────────────
function selectChain(result: unknown) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve?: Function) => {
      if (resolve) return Promise.resolve(resolve(result));
      return Promise.resolve(result);
    }),
  };
  return chain;
}

// ── Tests ──────────────────────────────────────────────────────
describe("GET /api/talos/:id/financial-summary — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no Authorization header is provided", async () => {
    mocks.mockVerifyAgentApiKey.mockResolvedValue({
      ok: false,
      response: Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 },
      ),
    });

    const request = new NextRequest(
      "http://localhost/api/talos/agent-1/financial-summary",
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain("Authorization");
  });

  it("returns 403 when an invalid API key is provided", async () => {
    mocks.mockVerifyAgentApiKey.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Invalid API key" }, { status: 403 }),
    });

    const request = new NextRequest(
      "http://localhost/api/talos/agent-1/financial-summary",
      { headers: { Authorization: "Bearer wrong_key_here" } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Invalid");
  });

  it("returns financial summary with valid auth", async () => {
    // 1. Auth succeeds
    mocks.mockVerifyAgentApiKey.mockResolvedValue({
      ok: true,
      talos: { id: "agent-1", apiKey: "valid-key" },
    });

    // 2. TALOS lookup succeeds
    const mockTalos = {
      id: "agent-1",
      name: "Test Agent",
      category: "Development",
      status: "Active",
      gtmBudget: "1000",
      createdAt: new Date(),
    };

    // The first select is the talos query which uses .limit(1).then(cb)
    mocks.mockSelect
      .mockReturnValueOnce(selectChain([mockTalos]))
      // revenueAllTime
      .mockReturnValueOnce(selectChain([{ totalRevenue: "500", transactionCount: 5 }]))
      // revenueLast30
      .mockReturnValueOnce(selectChain([{ totalRevenue: "200", transactionCount: 2 }]))
      // revenuePrev30
      .mockReturnValueOnce(selectChain([{ totalRevenue: "100" }]))
      // revenueBySource
      .mockReturnValueOnce(
        selectChain([
          { source: "commerce", total: "400", count: 4 },
          { source: "direct", total: "100", count: 1 },
        ]),
      )
      // monthlyRevenue
      .mockReturnValueOnce(
        selectChain([
          { month: "2026-01", revenue: 150, transactionCount: 3 },
          { month: "2026-02", revenue: 200, transactionCount: 2 },
        ]),
      )
      // spendingAllTime
      .mockReturnValueOnce(selectChain([{ totalSpent: "300", spendCount: 3 }]))
      // spendingLast30
      .mockReturnValueOnce(selectChain([{ totalSpent: "100", spendCount: 1 }]))
      // spendingByType
      .mockReturnValueOnce(
        selectChain([
          { type: "marketing", total: "200", count: 2 },
          { type: "ops", total: "100", count: 1 },
        ]),
      )
      // spendingHistory
      .mockReturnValueOnce(
        selectChain([
          {
            id: "s1",
            type: "marketing",
            title: "Ad campaign",
            description: "X ads",
            amount: "200",
            decidedAt: new Date(),
            txHash: "0xabc",
            createdAt: new Date(),
          },
        ]),
      )
      // playbookRows
      .mockReturnValueOnce(
        selectChain([
          {
            id: "pb1",
            title: "Growth Strategy",
            price: "9.99",
            currency: "USDC",
            category: "Channel Strategy",
            status: "active",
            purchaseCount: 3,
            totalSalesAmount: "29.97",
          },
        ]),
      );

    // 3. Execute handler
    const request = new NextRequest(
      "http://localhost/api/talos/agent-1/financial-summary",
      { headers: { Authorization: "Bearer valid-key" } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.talosId).toBe("agent-1");
    expect(body.talosName).toBe("Test Agent");
    expect(body.cashFlow).toBeDefined();
    expect(body.cashFlow.totalRevenue).toBe(500);
    expect(body.cashFlow.totalSpending).toBe(300);
    expect(body.trends).toBeDefined();
    expect(body.trends.revenueLast30Days).toBe(200);
    expect(body.budget).toBeDefined();
    expect(body.budget.gtmBudget).toBe(1000);
    expect(body.budget.budgetUtilization).toBe(30);
    expect(body.spendingHistory).toHaveLength(1);
    expect(body.playbookSales).toBeDefined();
    expect(body.playbookSales.totalPlaybooks).toBe(1);
    expect(body.playbookSales.totalSales).toBe(3);

    // Verify auth was called with correct args
    expect(mocks.mockVerifyAgentApiKey).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "agent-1",
    );
  });
});
