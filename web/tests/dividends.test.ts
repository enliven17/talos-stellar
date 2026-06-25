import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the database layer ───────────────────────────────────────
// We model the two query shapes the route uses:
//   GET:  db.select().from().where().limit().then()            (talos lookup)
//         db.select().from().where().orderBy().limit()         (list dividends)
//   POST: db.insert().values().returning()                    (record dividend)
const state = {
  talosExists: true,
  dividends: [] as unknown[],
  inserted: null as unknown,
};

function selectBuilder() {
  // Chainable thenable that resolves to either the talos row or the list,
  // depending on which terminal method is awaited.
  const builder: any = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    // GET talos-lookup path: `.limit(1).then((r) => r[0] ?? null)`
    then: (resolve: (rows: unknown[]) => void) =>
      Promise.resolve(state.talosExists ? [{ id: "talos_1" }] : []).then(resolve),
  };
  // GET list path: `await db.select()....limit(50)` returns the array directly.
  // Make `limit` return the dividends array when used as the final await.
  builder.limit = (n: number) =>
    n === 50 ? Promise.resolve(state.dividends) : builder;
  return builder;
}

vi.mock("@/db", () => ({
  db: {
    select: () => selectBuilder(),
    insert: () => ({
      values: (v: any) => ({
        returning: () => {
          state.inserted = { id: "div_1", ...v };
          return Promise.resolve([state.inserted]);
        },
      }),
    }),
  },
}));

// Mock auth: API key "good-key" passes, anything else fails.
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: vi.fn(async (req: Request) => {
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

import { GET, POST } from "@/app/api/talos/[id]/dividends/route";

const params = Promise.resolve({ id: "talos_1" });

function postReq(body: unknown, auth?: string) {
  return new Request("http://localhost/api/talos/talos_1/dividends", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  }) as any;
}

describe("GET /api/talos/[id]/dividends", () => {
  beforeEach(() => {
    state.talosExists = true;
    state.dividends = [
      { id: "div_1", talosId: "talos_1", amount: "12.500000", patronCount: 3 },
    ];
    state.inserted = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("returns the dividend history list", async () => {
    const res = await GET({} as any, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].amount).toBe("12.500000");
  });

  it("returns 404 when the TALOS does not exist", async () => {
    state.talosExists = false;
    const res = await GET({} as any, { params });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/talos/[id]/dividends", () => {
  beforeEach(() => {
    state.talosExists = true;
    state.inserted = null;
  });
  afterEach(() => vi.clearAllMocks());

  it("rejects unauthenticated requests with 403", async () => {
    const res = await POST(postReq({ amount: "10" }), { params });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await POST(postReq({ currency: "USDC" }, "Bearer good-key"), {
      params,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive amount with 400", async () => {
    const res = await POST(postReq({ amount: 0 }, "Bearer good-key"), { params });
    expect(res.status).toBe(400);
  });

  it("records a dividend distribution and returns 201", async () => {
    const res = await POST(
      postReq(
        {
          amount: "25.5",
          patronCount: 4,
          totalPulse: 100000,
          source: "manual",
          txHash: "abc123",
          breakdown: [{ stellarPublicKey: "GABC", amount: "25.5" }],
        },
        "Bearer good-key",
      ),
      { params },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("div_1");
    expect(body.talosId).toBe("talos_1");
    expect(body.amount).toBe("25.5");
    expect(body.patronCount).toBe(4);
    expect(body.source).toBe("manual");
    expect(body.status).toBe("completed");
  });

  it("defaults currency, source and status when omitted", async () => {
    const res = await POST(postReq({ amount: "5" }, "Bearer good-key"), {
      params,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.currency).toBe("USDC");
    expect(body.source).toBe("revenue-share");
    expect(body.status).toBe("completed");
  });
});
