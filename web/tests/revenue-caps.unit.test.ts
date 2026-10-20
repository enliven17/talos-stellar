import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { MAX_MONEY_AMOUNT } from "@/lib/schemas";

const state = {
  talosExists: true,
  inserted: null as any,
};

function selectBuilder(): any {
  const builder: any = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (onfulfilled?: any, onrejected?: any) =>
      Promise.resolve(state.talosExists ? [{ id: "talos_1" }] : []).then(
        onfulfilled,
        onrejected,
      ),
  };
  return builder;
}

vi.mock("@/db", () => ({
  db: {
    select: () => selectBuilder(),
    insert: () => ({
      values: (v: any) => ({
        returning: () => {
          state.inserted = { id: "rev_1", ...v };
          return Promise.resolve([state.inserted]);
        },
      }),
    }),
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn(async (req: NextRequest) => {
    const h = req.headers.get("authorization");
    if (h === "Bearer good-key") {
      return { ok: true, talos: { id: "talos_1", apiKey: "good-key" } };
    }
    return {
      ok: false,
      response: Response.json({ error: "Invalid API key" }, { status: 403 }),
    };
  }),
}));

vi.mock("@/lib/quota", () => ({
  checkAndIncrementQuota: vi.fn(async () => ({ ok: true })),
  quotaExceededResponse: vi.fn(),
}));

vi.mock("@/lib/webhooks/delivery", () => ({
  emitWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/talos/[id]/revenue/route";

const params = Promise.resolve({ id: "talos_1" });

function postReq(body: unknown, auth = "Bearer good-key"): NextRequest {
  return new NextRequest("http://localhost/api/talos/talos_1/revenue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: auth,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/talos/[id]/revenue — money amount caps (#1013)", () => {
  beforeEach(() => {
    state.talosExists = true;
    state.inserted = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("accepts a valid fixture number amount", async () => {
    const res = await POST(postReq({ amount: 250.5, source: "commerce" }), { params });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.amount).toBe("250.5");
    expect(body.source).toBe("commerce");
  });

  it("accepts a valid fixture string amount", async () => {
    const res = await POST(postReq({ amount: "100.50", source: "commerce" }), { params });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.amount).toBe("100.50");
  });

  it("rejects an amount above MAX_MONEY_AMOUNT (string)", async () => {
    const res = await POST(postReq({ amount: "1000000000001", source: "commerce" }), { params });
    expect(res.status).toBe(400);
  });

  it("rejects an amount above MAX_MONEY_AMOUNT (number)", async () => {
    const res = await POST(postReq({ amount: MAX_MONEY_AMOUNT, source: "commerce" }), { params });
    expect(res.status).toBe(400);
  });

  it("rejects an over-precise amount with 7 decimal places", async () => {
    const res = await POST(postReq({ amount: "1.0000001", source: "commerce" }), { params });
    expect(res.status).toBe(400);
  });

  it("rejects scientific notation in string amount", async () => {
    const res = await POST(postReq({ amount: "1e7", source: "commerce" }), { params });
    expect(res.status).toBe(400);
  });

  it("rejects zero or negative amount", async () => {
    const resZero = await POST(postReq({ amount: 0, source: "commerce" }), { params });
    expect(resZero.status).toBe(400);

    const resNeg = await POST(postReq({ amount: -5, source: "commerce" }), { params });
    expect(resNeg.status).toBe(400);
  });
});
