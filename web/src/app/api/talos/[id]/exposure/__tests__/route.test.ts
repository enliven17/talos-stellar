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

describe("GET /api/talos/:id/exposure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Missing Authorization header" }, { status: 401 }),
    });

    const response = await GET(new NextRequest("http://localhost/api/talos/agent-1/exposure"), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(401);
  });

  it("returns exposure rows for authorized requests", async () => {
    mocks.verifyAgentApiKey.mockResolvedValue({ ok: true, talos: { id: "agent-1", apiKey: "valid" } });
    mocks.select
      .mockReturnValueOnce(chain([{ id: "agent-1" }]))
      .mockReturnValueOnce(chain([
        {
          counterpartyId: "counterparty-1",
          asset: "USDC",
          category: "service-a",
          reservedAmount: "250",
          settledAmount: "100",
          reservedCount: 2,
          settledCount: 1,
          lastObservedAt: new Date("2026-07-25T00:00:00.000Z"),
        },
      ]));

    const response = await GET(new NextRequest("http://localhost/api/talos/agent-1/exposure?window=7d&limit=5"), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exposures).toHaveLength(1);
    expect(body.exposures[0].reservedAmount).toBe(250);
    expect(body.exposures[0].settledAmount).toBe(100);
    expect(body.windowDays).toBe(7);
  });
});
