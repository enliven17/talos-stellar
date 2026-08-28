import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, toMonetaryValue } from "../route";

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
describe("GET /api/talos/:id/financial-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Auth tests", () => {
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
  });

  describe("Standard history calculations", () => {
    it("returns financial summary with valid auth", async () => {
      mocks.mockVerifyAgentApiKey.mockResolvedValue({
        ok: true,
        talos: { id: "agent-1", apiKey: "valid-key" },
      });

      const mockTalos = {
        id: "agent-1",
        name: "Test Agent",
        category: "Development",
        status: "Active",
        gtmBudget: "1000",
        createdAt: new Date(),
      };

      mocks.mockSelect
        .mockReturnValueOnce(selectChain([mockTalos]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "500", transactionCount: 5 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "200", transactionCount: 2 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "100" }]))
        .mockReturnValueOnce(
          selectChain([
            { source: "commerce", total: "400", count: 4 },
            { source: "direct", total: "100", count: 1 },
          ]),
        )
        .mockReturnValueOnce(
          selectChain([
            { month: "2026-01", total: "150", count: 3 },
            { month: "2026-02", total: "200", count: 2 },
          ]),
        )
        .mockReturnValueOnce(selectChain([{ totalSpent: "300", spendCount: 3 }]))
        .mockReturnValueOnce(selectChain([{ totalSpent: "100", spendCount: 1 }]))
        .mockReturnValueOnce(
          selectChain([
            { type: "marketing", total: "200", count: 2 },
            { type: "ops", total: "100", count: 1 },
          ]),
        )
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

      expect(mocks.mockVerifyAgentApiKey).toHaveBeenCalledWith(
        expect.any(NextRequest),
        "agent-1",
        ["revenue:read"],
      );
    });
  });

  describe("Hardened edge cases & monetary representation", () => {
    it("handles an agent with no revenue, no patrons, and no completed jobs (empty state)", async () => {
      mocks.mockVerifyAgentApiKey.mockResolvedValue({
        ok: true,
        talos: { id: "agent-empty", apiKey: "valid-key" },
      });

      const mockTalos = {
        id: "agent-empty",
        name: "Empty Agent",
        category: "Development",
        status: "Active",
        gtmBudget: "200",
        createdAt: new Date(),
      };

      mocks.mockSelect
        .mockReturnValueOnce(selectChain([mockTalos]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0", transactionCount: 0 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0", transactionCount: 0 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0" }]))
        .mockReturnValueOnce(selectChain([])) // revenueBySource
        .mockReturnValueOnce(selectChain([])) // monthlyRevenue
        .mockReturnValueOnce(selectChain([{ totalSpent: "0", spendCount: 0 }]))
        .mockReturnValueOnce(selectChain([{ totalSpent: "0", spendCount: 0 }]))
        .mockReturnValueOnce(selectChain([])) // spendingByType
        .mockReturnValueOnce(selectChain([])) // spendingHistory
        .mockReturnValueOnce(selectChain([])); // playbookRows

      const request = new NextRequest(
        "http://localhost/api/talos/agent-empty/financial-summary",
        { headers: { Authorization: "Bearer valid-key" } },
      );
      const response = await GET(request, {
        params: Promise.resolve({ id: "agent-empty" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.talosId).toBe("agent-empty");
      expect(body.cashFlow.totalRevenue).toBe(0);
      expect(body.cashFlow.totalSpending).toBe(0);
      expect(body.cashFlow.netProfit).toBe(0);
      expect(body.cashFlow.profitMargin).toBe(0);
      expect(body.cashFlow.revenueTransactionCount).toBe(0);
      expect(body.cashFlow.spendingTransactionCount).toBe(0);
      expect(Array.isArray(body.cashFlow.revenueBySource)).toBe(true);
      expect(body.cashFlow.revenueBySource).toHaveLength(0);
      expect(Array.isArray(body.cashFlow.spendingByType)).toBe(true);
      expect(body.cashFlow.spendingByType).toHaveLength(0);

      expect(body.trends.revenueLast30Days).toBe(0);
      expect(body.trends.revenuePrevious30Days).toBe(0);
      expect(body.trends.revenueGrowthRate).toBe(0);
      expect(body.trends.spendingLast30Days).toBe(0);
      expect(body.trends.netProfitLast30Days).toBe(0);
      expect(body.trends.annualizedRunRate).toBe(0);
      expect(Array.isArray(body.trends.monthlyRevenue)).toBe(true);
      expect(body.trends.monthlyRevenue).toHaveLength(0);

      expect(body.budget.gtmBudget).toBe(200);
      expect(body.budget.totalApprovedSpending).toBe(0);
      expect(body.budget.budgetUtilization).toBe(0);
      expect(body.budget.budgetRemaining).toBe(200);

      expect(Array.isArray(body.spendingHistory)).toBe(true);
      expect(body.spendingHistory).toHaveLength(0);

      expect(body.playbookSales.totalPlaybooks).toBe(0);
      expect(body.playbookSales.totalSales).toBe(0);
      expect(body.playbookSales.totalRevenue).toBe(0);
      expect(Array.isArray(body.playbookSales.playbooks)).toBe(true);
      expect(body.playbookSales.playbooks).toHaveLength(0);

      // JSON serialization stability check
      const jsonString = JSON.stringify(body);
      expect(jsonString).not.toContain("null,\"revenueBySource\"");
      expect(jsonString).not.toContain("NaN");
    });

    it("handles decimal precision, float arithmetic, and stable JSON serialization", async () => {
      mocks.mockVerifyAgentApiKey.mockResolvedValue({
        ok: true,
        talos: { id: "agent-decimals", apiKey: "valid-key" },
      });

      const mockTalos = {
        id: "agent-decimals",
        name: "Decimal Agent",
        category: "Finance",
        status: "Active",
        gtmBudget: "500.555555",
        createdAt: new Date(),
      };

      mocks.mockSelect
        .mockReturnValueOnce(selectChain([mockTalos]))
        // revenueAllTime: sum of 0.1 and 0.2 decimal float addition test
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0.300000", transactionCount: 2 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0.150000", transactionCount: 1 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0.100000" }]))
        .mockReturnValueOnce(
          selectChain([
            { source: "commerce", total: "0.200000", count: 1 },
            { source: "direct", total: "0.100000", count: 1 },
          ]),
        )
        .mockReturnValueOnce(
          selectChain([
            { month: "2026-01", total: "0.100000", count: 1 },
            { month: "2026-02", total: "0.200000", count: 1 },
          ]),
        )
        .mockReturnValueOnce(selectChain([{ totalSpent: "0.100000", spendCount: 1 }]))
        .mockReturnValueOnce(selectChain([{ totalSpent: "0.050000", spendCount: 1 }]))
        .mockReturnValueOnce(
          selectChain([{ type: "marketing", total: "0.100000", count: 1 }]),
        )
        .mockReturnValueOnce(
          selectChain([
            {
              id: "s1",
              type: "marketing",
              title: "Micro spend",
              description: null,
              amount: "0.100000",
              decidedAt: null,
              txHash: null,
              createdAt: new Date("2026-08-25T12:00:00Z"),
            },
          ]),
        )
        .mockReturnValueOnce(
          selectChain([
            {
              id: "pb1",
              title: "Micro Playbook",
              price: "0.050000",
              currency: "USDC",
              category: "Content Templates",
              status: "active",
              purchaseCount: 2,
              totalSalesAmount: "0.100000",
            },
          ]),
        );

      const request = new NextRequest(
        "http://localhost/api/talos/agent-decimals/financial-summary",
        { headers: { Authorization: "Bearer valid-key" } },
      );
      const response = await GET(request, {
        params: Promise.resolve({ id: "agent-decimals" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.cashFlow.totalRevenue).toBe(0.3);
      expect(body.cashFlow.totalSpending).toBe(0.1);
      expect(body.cashFlow.netProfit).toBe(0.2);

      // Verify profit margin: 0.2 / 0.3 * 100 = 66.6666... -> 66.67
      expect(body.cashFlow.profitMargin).toBe(66.67);

      // Verify growth rate: (0.15 - 0.10) / 0.10 * 100 = 50%
      expect(body.trends.revenueGrowthRate).toBe(50);

      expect(body.playbookSales.playbooks[0].salesRevenue).toBe(0.1);
      expect(body.playbookSales.totalRevenue).toBe(0.1);

      // JSON serialization assertion
      const jsonString = JSON.stringify(body);
      expect(jsonString).not.toContain("0.30000000000000004");
      expect(jsonString).not.toContain("NaN");

      const parsedBack = JSON.parse(jsonString);
      expect(parsedBack).toEqual(body);
    });

    it("handles negative and invalid persisted database rows safely", async () => {
      mocks.mockVerifyAgentApiKey.mockResolvedValue({
        ok: true,
        talos: { id: "agent-invalid", apiKey: "valid-key" },
      });

      const mockTalos = {
        id: "agent-invalid",
        name: "Invalid DB Agent",
        category: "Analytics",
        status: "Active",
        gtmBudget: "invalid_budget",
        createdAt: new Date(),
      };

      mocks.mockSelect
        .mockReturnValueOnce(selectChain([mockTalos]))
        // Negative revenue amount in DB row
        .mockReturnValueOnce(selectChain([{ totalRevenue: "-50.00", transactionCount: -1 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "not_a_number", transactionCount: 0 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: null }]))
        .mockReturnValueOnce(
          selectChain([
            { source: "commerce", total: "invalid", count: -2 },
          ]),
        )
        .mockReturnValueOnce(
          selectChain([
            { month: "2026-01", total: "bad_val", count: 0 },
          ]),
        )
        // Negative spending amount in DB row
        .mockReturnValueOnce(selectChain([{ totalSpent: "-20.00", spendCount: 0 }]))
        .mockReturnValueOnce(selectChain([{ totalSpent: "undefined", spendCount: 0 }]))
        .mockReturnValueOnce(
          selectChain([{ type: "ops", total: "invalid", count: 0 }]),
        )
        .mockReturnValueOnce(
          selectChain([
            {
              id: "s1",
              type: "ops",
              title: "Corrupted approval",
              description: null,
              amount: "invalid_amount",
              decidedAt: null,
              txHash: null,
              createdAt: "2026-08-25T12:00:00Z",
            },
          ]),
        )
        .mockReturnValueOnce(
          selectChain([
            {
              id: "pb1",
              title: "Corrupted Playbook",
              price: "invalid_price",
              currency: "USDC",
              category: "Design",
              status: "active",
              purchaseCount: -5,
              totalSalesAmount: "invalid",
            },
          ]),
        );

      const request = new NextRequest(
        "http://localhost/api/talos/agent-invalid/financial-summary",
        { headers: { Authorization: "Bearer valid-key" } },
      );
      const response = await GET(request, {
        params: Promise.resolve({ id: "agent-invalid" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Negative gross revenue/spending rows are clamped to 0
      expect(body.cashFlow.totalRevenue).toBe(0);
      expect(body.cashFlow.totalSpending).toBe(0);
      expect(body.cashFlow.netProfit).toBe(0);
      expect(body.cashFlow.profitMargin).toBe(0);
      expect(body.cashFlow.revenueTransactionCount).toBe(0);
      expect(body.cashFlow.spendingTransactionCount).toBe(0);

      expect(body.cashFlow.revenueBySource[0].total).toBe(0);
      expect(body.cashFlow.revenueBySource[0].count).toBe(0);

      expect(body.spendingHistory[0].amount).toBe(0);
      expect(body.playbookSales.playbooks[0].price).toBe(0);
      expect(body.playbookSales.playbooks[0].purchaseCount).toBe(0);

      // JSON serialization does not crash or output NaN
      const jsonString = JSON.stringify(body);
      expect(jsonString).not.toContain("NaN");
      expect(jsonString).not.toContain("null,\"totalRevenue\"");
    });

    it("handles large Stellar integer and decimal values without overflow or precision loss", async () => {
      mocks.mockVerifyAgentApiKey.mockResolvedValue({
        ok: true,
        talos: { id: "agent-large", apiKey: "valid-key" },
      });

      const mockTalos = {
        id: "agent-large",
        name: "Whale Agent",
        category: "Finance",
        status: "Active",
        gtmBudget: "1000000000000000",
        createdAt: new Date(),
      };

      const largeRevenue = "1000000000000000.123456"; // 1 quadrillion XLM/USDC + 6 decimals

      mocks.mockSelect
        .mockReturnValueOnce(selectChain([mockTalos]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: largeRevenue, transactionCount: 1000000 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: largeRevenue, transactionCount: 1000000 }]))
        .mockReturnValueOnce(selectChain([{ totalRevenue: "0" }]))
        .mockReturnValueOnce(
          selectChain([{ source: "commerce", total: largeRevenue, count: 1000000 }]),
        )
        .mockReturnValueOnce(
          selectChain([{ month: "2026-08", total: largeRevenue, count: 1000000 }]),
        )
        .mockReturnValueOnce(selectChain([{ totalSpent: "500000000000000.000000", spendCount: 5000 }]))
        .mockReturnValueOnce(selectChain([{ totalSpent: "500000000000000.000000", spendCount: 5000 }]))
        .mockReturnValueOnce(
          selectChain([{ type: "treasury", total: "500000000000000.000000", count: 5000 }]),
        )
        .mockReturnValueOnce(
          selectChain([
            {
              id: "s1",
              type: "treasury",
              title: "Mega allocation",
              description: "Large transfer",
              amount: "500000000000000.000000",
              decidedAt: new Date(),
              txHash: "0xwhaletx",
              createdAt: new Date(),
            },
          ]),
        )
        .mockReturnValueOnce(selectChain([]));

      const request = new NextRequest(
        "http://localhost/api/talos/agent-large/financial-summary",
        { headers: { Authorization: "Bearer valid-key" } },
      );
      const response = await GET(request, {
        params: Promise.resolve({ id: "agent-large" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.cashFlow.totalRevenue).toBe(1000000000000000.123456);
      expect(body.cashFlow.totalSpending).toBe(500000000000000);
      expect(body.cashFlow.netProfit).toBe(500000000000000.123456);

      const jsonString = JSON.stringify(body);
      expect(jsonString).not.toContain("NaN");
      const parsed = JSON.parse(jsonString);
      expect(parsed.cashFlow.totalRevenue).toBe(1000000000000000.123456);
    });
  });

  describe("toMonetaryValue helper unit tests", () => {
    it("obeys documented monetary representation rules", () => {
      expect(toMonetaryValue(null)).toBe(0);
      expect(toMonetaryValue(undefined)).toBe(0);
      expect(toMonetaryValue("invalid")).toBe(0);
      expect(toMonetaryValue(NaN)).toBe(0);
      expect(toMonetaryValue(Infinity)).toBe(0);
      expect(toMonetaryValue(-Infinity)).toBe(0);

      // Floats rounding artifacts: 0.1 + 0.2
      expect(toMonetaryValue(0.1 + 0.2)).toBe(0.3);

      // Default non-negative clamping for gross amounts
      expect(toMonetaryValue("-100")).toBe(0);
      expect(toMonetaryValue(-100)).toBe(0);

      // Allowing negative for net profits
      expect(toMonetaryValue("-100", { allowNegative: true })).toBe(-100);

      // Decimal precision bounded to 6 fractional places
      expect(toMonetaryValue("12.3456789")).toBe(12.345679);

      // Large values
      expect(toMonetaryValue("9007199254740991")).toBe(9007199254740991);
    });
  });
});
