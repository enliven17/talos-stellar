/**
 * Smoke tests for the SDK examples.
 *
 * Each test imports an example file's logic through the public SDK API and
 * verifies that the method calls compile (type-check) and produce the right
 * network calls against a mocked fetch. No real network requests are made.
 *
 * Relates to: https://github.com/enliven17/talos-stellar/issues/986
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";
import type {
  TalosCreated,
  CursorPage,
  Talos,
  Activity,
  Revenue,
  CommerceService,
  CommerceJob,
  SignedPayment,
  Playbook,
  LeaderboardEntry,
  Approval,
} from "../src/types.js";

const BASE = "http://localhost:3000";

function makeClient(): TalosClient {
  return new TalosClient({ baseUrl: BASE, apiKey: "tlk_test" });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

// ── helpers ────────────────────────────────────────────────────────────────

function ok<T>(body: T): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function cursorPage<T>(items: T[]): CursorPage<T> {
  return { data: items, nextCursor: null };
}

// ── 01-create-talos ────────────────────────────────────────────────────────

describe("example 01 – createTalos", () => {
  it("calls POST /api/talos and returns TalosCreated shape", async () => {
    const mockCreated: TalosCreated = {
      id: "talos_001",
      name: "AlphaBot",
      category: "commerce",
      description: "Autonomous commerce agent",
      status: "active",
      pulsePrice: "0",
      totalSupply: 1_000_000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 0,
      channels: [],
      approvalThreshold: "0",
      gtmBudget: "0",
      agentOnline: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      apiKeyOnce: "tlk_newkey_abc123",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockCreated));

    const client = makeClient();
    const result: TalosCreated = await client.createTalos({
      name: "AlphaBot",
      category: "commerce",
      description: "Autonomous commerce agent",
      totalSupply: 1_000_000,
      tokenSymbol: "ALPHA",
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.id).toBe("talos_001");
    // Type-level: apiKeyOnce must be a string
    const _: string = result.apiKeyOnce;
    expect(typeof result.apiKeyOnce).toBe("string");
  });
});

// ── 02-list-taloses ────────────────────────────────────────────────────────

describe("example 02 – listTaloses", () => {
  it("calls GET /api/talos with pagination params", async () => {
    const mockTalos: Talos = {
      id: "talos_002",
      name: "BetaBot",
      category: "analytics",
      description: "Analytics agent",
      status: "active",
      pulsePrice: "0",
      totalSupply: 500_000,
      creatorShare: 0,
      investorShare: 0,
      treasuryShare: 0,
      channels: [],
      approvalThreshold: "0",
      gtmBudget: "0",
      agentOnline: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(cursorPage([mockTalos])));

    const client = makeClient();
    const page: CursorPage<Talos> = await client.listTaloses({ limit: 10 });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/talos?limit=10"),
      expect.any(Object),
    );
    expect(page.data).toHaveLength(1);
    expect(page.data[0].name).toBe("BetaBot");
    // Type check: nextCursor is string | null
    const _: string | null = page.nextCursor;
  });
});

// ── 03-report-activity ─────────────────────────────────────────────────────

describe("example 03 – reportActivity / reportRevenue", () => {
  it("reports activity and returns Activity shape", async () => {
    const mockActivity: Activity = {
      id: "act_001",
      talosId: "talos_abc",
      type: "commerce",
      content: "Sold data-analysis report",
      channel: "marketplace",
      status: "completed",
      createdAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockActivity));

    const client = makeClient();
    const result: Activity = await client.reportActivity("talos_abc", {
      type: "commerce",
      content: "Sold data-analysis report",
      channel: "marketplace",
      status: "completed",
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/talos_abc/activity`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.type).toBe("commerce");
  });

  it("reports revenue and returns Revenue shape", async () => {
    const mockRevenue: Revenue = {
      id: "rev_001",
      talosId: "talos_abc",
      amount: "0.5",
      currency: "USDC",
      source: "commerce",
      createdAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockRevenue));

    const client = makeClient();
    const result: Revenue = await client.reportRevenue("talos_abc", {
      amount: 0.5,
      currency: "USDC",
      source: "commerce",
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/talos_abc/revenue`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.currency).toBe("USDC");
  });
});

// ── 04-commerce-service ────────────────────────────────────────────────────

describe("example 04 – registerService / discoverServices", () => {
  it("registers a service via PUT and returns CommerceService", async () => {
    const mockService: CommerceService = {
      id: "svc_001",
      talosId: "talos_abc",
      serviceName: "Sentiment Analysis",
      description: "Real-time social sentiment",
      price: "1.0",
      currency: "USDC",
      stellarPublicKey: "GABC",
      chains: ["stellar:testnet"],
      fulfillmentMode: "async",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockService));

    const client = makeClient();
    const result: CommerceService = await client.registerService("talos_abc", {
      serviceName: "Sentiment Analysis",
      description: "Real-time social sentiment",
      price: 1.0,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/talos_abc/service`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(result.serviceName).toBe("Sentiment Analysis");
  });

  it("discovers services with cursor pagination", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok(cursorPage([])));

    const client = makeClient();
    const page: CursorPage<CommerceService> = await client.discoverServices({ limit: 5 });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/services?limit=5"),
      expect.any(Object),
    );
    expect(Array.isArray(page.data)).toBe(true);
  });
});

// ── 05-x402-payment ────────────────────────────────────────────────────────

describe("example 05 – signPayment", () => {
  it("signs a payment and returns SignedPayment shape", async () => {
    const mockSigned: SignedPayment = {
      paymentHeader: "x402-signed-header",
      from: "GABC",
      to: "GDEF",
      amount: "0.5",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockSigned));

    const client = makeClient();
    const result: SignedPayment = await client.signPayment("talos_buyer", {
      payee: "GDEF",
      amount: 0.5,
      assetCode: "USDC",
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/talos_buyer/sign`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.paymentHeader).toBe("x402-signed-header");
    // Type check: all fields are strings
    const _from: string = result.from;
    const _amount: string = result.amount;
    expect(typeof _from).toBe("string");
    expect(typeof _amount).toBe("string");
  });
});

// ── 06-playbooks ───────────────────────────────────────────────────────────

describe("example 06 – createPlaybook / listPlaybooks", () => {
  it("creates a playbook via POST /api/playbooks", async () => {
    const mockPlaybook: Playbook = {
      id: "pb_001",
      talosId: "talos_abc",
      title: "Stellar DeFi Scanner",
      category: "defi",
      channel: "stellar",
      description: "Arbitrage opportunities",
      price: "2.5",
      currency: "USDC",
      version: 1,
      tags: ["defi"],
      status: "active",
      impressions: 0,
      engagementRate: "0",
      conversions: 0,
      periodDays: 30,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockPlaybook));

    const client = makeClient();
    const result: Playbook = await client.createPlaybook({
      title: "Stellar DeFi Scanner",
      category: "defi",
      channel: "stellar",
      description: "Arbitrage opportunities",
      price: 2.5,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/playbooks`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.category).toBe("defi");
    // Type check: version is a number
    const _version: number = result.version;
    expect(typeof _version).toBe("number");
  });
});

// ── 07-leaderboard-and-approvals ──────────────────────────────────────────

describe("example 07 – getLeaderboard / createApproval", () => {
  it("fetches leaderboard and returns typed entries", async () => {
    const mockEntry: LeaderboardEntry = {
      id: "talos_abc",
      name: "AlphaBot",
      category: "commerce",
      status: "active",
      pulsePrice: "1.0",
      totalSupply: 1_000_000,
      patronCount: 42,
      activityCount: 100,
      totalRevenue: 500,
      marketCap: 1_000_000,
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(cursorPage([mockEntry])));

    const client = makeClient();
    const board: CursorPage<LeaderboardEntry> = await client.getLeaderboard({ limit: 10 });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/leaderboard?limit=10"),
      expect.any(Object),
    );
    expect(board.data[0].patronCount).toBe(42);
    // Type check: marketCap is a number
    const _mc: number = board.data[0].marketCap;
    expect(typeof _mc).toBe("number");
  });

  it("creates an approval and returns Approval shape", async () => {
    const mockApproval: Approval = {
      id: "apr_001",
      talosId: "talos_abc",
      type: "strategy",
      title: "Expand arbitrage",
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    vi.mocked(fetch).mockResolvedValueOnce(ok(mockApproval));

    const client = makeClient();
    const result: Approval = await client.createApproval("talos_abc", {
      type: "strategy",
      title: "Expand arbitrage",
      description: "Allocate 20 USDC",
      amount: 20,
    });

    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/talos/talos_abc/approvals`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("pending");
  });
});

// ── Type-level: no implicit any from SDK exports ──────────────────────────

describe("type-level: SDK exports are fully typed", () => {
  it("TalosClient constructor accepts all documented options without any", () => {
    const client = new TalosClient({
      baseUrl: "https://talos-stellar.vercel.app",
      apiKey: "tlk_key",
      retryPolicy: {
        maxAttempts: 5,
        baseDelayMs: 200,
        maxDelayMs: 5000,
        retryMethods: ["GET"],
        retryStatusCodes: [429, 503],
        jitter: false,
      },
    });
    // Type check: client is a TalosClient
    const _: TalosClient = client;
    expect(client).toBeInstanceOf(TalosClient);
  });
});
