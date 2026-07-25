import { describe, expect, it, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

const mocks = vi.hoisted(() => ({
  verifyAgentApiKey: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: mocks.verifyAgentApiKey,
}));

vi.mock("@/db", () => ({
  db: {
    select: mocks.select,
  },
}));

function chain(result: unknown) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve?: Function) => {
      if (resolve) return Promise.resolve(resolve(result));
      return Promise.resolve(result);
    }),
  };
  return chain;
}

describe("GET /api/talos/:id/exposure/alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Missing Authorization header" }, { status: 401 }),
    });

    const response = await GET(new NextRequest("http://localhost/api/talos/agent-1/exposure/alerts"), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(401);
  });

  it("emits alerts for high-risk exposure", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: "agent-1", apiKey: "valid" } });
    mocks.select
      .mockReturnValueOnce(chain([{ id: "agent-1" }]))
      .mockReturnValueOnce(chain([
        {
          counterpartyId: "counterparty-1",
          asset: "USDC",
          reservedAmount: "1200",
          settledAmount: "100",
          deniedCount: 3,
          lastObservedAt: new Date("2026-07-25T00:00:00.000Z"),
        },
      ]));

    const response = await GET(new NextRequest("http://localhost/api/talos/agent-1/exposure/alerts?window=7"), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.alerts.some((alert: { type: string }) => alert.type === "saturation")).toBe(true);
    expect(body.alerts.some((alert: { type: string }) => alert.type === "repeated-denial")).toBe(true);
    expect(body.alerts.some((alert: { type: string }) => alert.type === "reconciliation-drift")).toBe(true);
  });
});
