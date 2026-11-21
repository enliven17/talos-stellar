import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

const mocks = vi.hoisted(() => ({
  fetchActivityStats: vi.fn(),
  fetchActivityTransactions: vi.fn(),
}));

vi.mock("../query", () => ({
  decodeActivityCursor: vi.fn(),
  fetchActivityStats: mocks.fetchActivityStats,
  fetchActivityTransactions: mocks.fetchActivityTransactions,
  InvalidActivityCursorError: class InvalidActivityCursorError extends Error {},
}));

const stats = {
  totalTransactions: 1,
  totalVolume: 3,
  activeAgents: 1,
  totalAgents: 2,
  registeredServices: 1,
  playbooksTraded: 0,
};

function transaction(id: string) {
  return {
    id,
    type: "service" as const,
    sellerName: "Seller",
    sellerAgent: "seller-agent",
    buyerName: "=HYPERLINK(\"https://example.invalid\")",
    buyerAgent: "buyer-agent",
    itemName: 'Quoted, "service"',
    amount: 3,
    currency: "USDC",
    status: "completed",
    timestamp: "2026-09-30T12:00:00.000Z",
    txHash: "payment-proof-secret",
  };
}

function request(path: string) {
  return new Request(`http://localhost/api/activity${path}`);
}

describe("GET /api/activity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchActivityStats.mockResolvedValue(stats);
    mocks.fetchActivityTransactions.mockResolvedValue({ transactions: [], nextCursor: null });
  });

  it("preserves the existing JSON response for callers without a format", async () => {
    mocks.fetchActivityTransactions.mockResolvedValue({
      transactions: [transaction("activity-1")],
      nextCursor: "next-page",
    });

    const response = await GET(request(""));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stats,
      transactions: [transaction("activity-1")],
      nextCursor: "next-page",
    });
    expect(mocks.fetchActivityTransactions).toHaveBeenCalledWith(25, null);
  });

  it("exports every page of the selected type without private identifiers", async () => {
    mocks.fetchActivityTransactions
      .mockResolvedValueOnce({
        transactions: [transaction("activity-1")],
        nextCursor: "next-page",
      })
      .mockResolvedValueOnce({
        transactions: [transaction("activity-2")],
        nextCursor: null,
      });

    const response = await GET(request("?format=csv&type=service"));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(csv).toContain("timestamp,type,buyer,seller,item,amount,currency,status");
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
    expect(csv).toContain('"Quoted, ""service"""');
    expect(csv).not.toContain("activity-1");
    expect(csv).not.toContain("payment-proof-secret");
    expect(csv).not.toContain("buyer-agent");
    expect(mocks.fetchActivityTransactions).toHaveBeenCalledWith(100, null, "service");
    expect(mocks.fetchActivityTransactions).toHaveBeenNthCalledWith(2, 100, "next-page", "service");
    expect(mocks.fetchActivityStats).not.toHaveBeenCalled();
  });

  it("rejects unknown format and type values explicitly", async () => {
    const invalidFormat = await GET(request("?format=json"));
    const invalidType = await GET(request("?format=csv&type=agent"));
    const invalidPagination = await GET(request("?format=csv&cursor=next"));

    expect(invalidFormat.status).toBe(400);
    expect((await invalidFormat.json()).message).toBe("Invalid activity format");
    expect(invalidType.status).toBe(400);
    expect((await invalidType.json()).message).toBe("Invalid activity type");
    expect(invalidPagination.status).toBe(400);
    expect((await invalidPagination.json()).message).toBe("CSV exports do not accept pagination parameters");
    expect(mocks.fetchActivityTransactions).not.toHaveBeenCalled();
  });

  it("returns a bounded error when the export exceeds 10,000 rows", async () => {
    const transactions = Array.from({ length: 100 }, (_, index) => transaction(`activity-${index}`));
    let pageNumber = 0;
    mocks.fetchActivityTransactions.mockImplementation(() => {
      pageNumber += 1;
      return Promise.resolve({ transactions, nextCursor: `page-${pageNumber}` });
    });

    const response = await GET(request("?format=csv"));
    const body = await response.text();

    expect(response.status).toBe(413);
    expect(body).toContain("Activity export exceeds the 10,000 row limit");
    expect(body).not.toContain("payment-proof-secret");
    expect(mocks.fetchActivityTransactions).toHaveBeenCalledTimes(100);
  });

  it("allows an export containing exactly 10,000 rows", async () => {
    const transactions = Array.from({ length: 100 }, (_, index) => transaction(`activity-${index}`));
    let pageNumber = 0;
    mocks.fetchActivityTransactions.mockImplementation(() => {
      pageNumber += 1;
      return Promise.resolve({
        transactions,
        nextCursor: pageNumber < 100 ? `page-${pageNumber}` : null,
      });
    });

    const response = await GET(request("?format=csv"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(mocks.fetchActivityTransactions).toHaveBeenCalledWith(100, null, null);
    expect(mocks.fetchActivityTransactions).toHaveBeenCalledTimes(100);
  });

  it("does not expose dependency failure details", async () => {
    mocks.fetchActivityTransactions.mockRejectedValue(new Error("db password leaked"));

    const response = await GET(request("?format=csv"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("An unexpected error occurred");
    expect(body).not.toContain("db password leaked");
  });
});