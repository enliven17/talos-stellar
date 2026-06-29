import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// ── Hoisted mocks ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  mockVerifyAgentApiKey: vi.fn(),
  mockFindFirstTalos: vi.fn(),
  mockSelect: vi.fn(),
  mockAnalyzeWithGPT: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.mockVerifyAgentApiKey,
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: {
        findFirst: mocks.mockFindFirstTalos,
      },
    },
    select: mocks.mockSelect,
  },
}));

vi.mock("@/lib/fulfillment/clients", () => ({
  analyzeWithGPT: mocks.mockAnalyzeWithGPT,
}));

// ── Helper: mock a Drizzle select chain ────────────────────────
function selectChain(result: unknown) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
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
describe("GET /api/talos/:id/financial-projection — auth", () => {
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
      "http://localhost/api/talos/agent-1/financial-projection",
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
      "http://localhost/api/talos/agent-1/financial-projection",
      { headers: { Authorization: "Bearer wrong_key_here" } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("Invalid");
  });

  it("returns financial projections with valid auth", async () => {
    // 1. Auth succeeds
    mocks.mockVerifyAgentApiKey.mockResolvedValue({
      ok: true,
      talos: { id: "agent-1", apiKey: "valid-key" },
    });

    // 2. Talos lookup succeeds
    const mockTalos = {
      id: "agent-1",
      name: "Test Agent",
      category: "Development",
      description: "A test TALOS agent",
      gtmBudget: "1000",
      totalSupply: 500_000,
      pulsePrice: "1.0",
      creatorShare: 40,
      investorShare: 30,
      treasuryShare: 30,
    };
    mocks.mockFindFirstTalos.mockResolvedValue(mockTalos);

    // 3. Revenue, activity & patron queries
    const now = new Date();
    mocks.mockSelect
      .mockReturnValueOnce(
        selectChain([
          {
            id: "r1",
            talosId: "agent-1",
            amount: "250",
            source: "commerce",
            currency: "USDC",
            createdAt: now,
          },
        ]),
      )
      .mockReturnValueOnce(
        selectChain([
          {
            id: "a1",
            talosId: "agent-1",
            type: "post",
            content: "Hello X",
            channel: "X",
            status: "completed",
            createdAt: now,
          },
        ]),
      )
      .mockReturnValueOnce(
        selectChain([
          {
            id: "p1",
            talosId: "agent-1",
            walletAddress: "0xPATRON",
            pulseAmount: 1000,
            role: "Investor",
            status: "active",
          },
        ]),
      );

    // 4. LLM returns projection
    const mockProjection = {
      expectedRevenue: {
        monthly: [100, 200, 300, 400, 500, 600],
        quarterly: [600, 1500, 1500],
        yearly: 3600,
      },
      budgetSuggestions: [
        {
          category: "Marketing",
          amount: 400,
          rationale: "GTM budget allocation",
        },
      ],
      roiEstimations: {
        shortTerm: 10,
        mediumTerm: 25,
        longTerm: 50,
        confidence: "medium" as const,
      },
      insights: ["Revenue is trending upward"],
    };
    mocks.mockAnalyzeWithGPT.mockResolvedValue(
      JSON.stringify(mockProjection),
    );

    // 5. Execute handler
    const request = new NextRequest(
      "http://localhost/api/talos/agent-1/financial-projection",
      { headers: { Authorization: "Bearer valid-key" } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.projection).toBeDefined();
    expect(body.metadata).toBeDefined();
    expect(body.metadata.talosId).toBe("agent-1");
    expect(body.projection.expectedRevenue.monthly).toEqual([
      100, 200, 300, 400, 500, 600,
    ]);
    expect(body.projection.roiEstimations.confidence).toBe("medium");
    expect(body.projection.insights).toContain("Revenue is trending upward");

    // Verify auth was called with correct args
    expect(mocks.mockVerifyAgentApiKey).toHaveBeenCalledWith(
      expect.any(NextRequest),
      "agent-1",
    );
  });
});
