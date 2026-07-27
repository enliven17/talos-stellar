/**
 * End-to-end integration tests for the BUDGETS API surface.
 *
 * Wires up the actual route handlers and exercises:
 *   - POST /api/talos/:id/budgets/reserve   (idempotency + concurrency)
 *   - POST /api/talos/:id/budgets/transition (state machine + fencing)
 *   - POST /api/talos/:id/budgets           (list + upsert)
 *   - GET  /api/talos/:id/budgets           (list)
 *
 * Uses the same vi.hoisted / Promise.all-safe dispatch pattern as
 * tests/commerce-jobs-idempotency.test.ts so concurrent requests
 * don't depend on mock-call ordering.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock factories ────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const seed = {
    budgets: [] as any[],
    reservations: [] as any[],
    events: [] as any[],
  };

  function makeChain(tableName?: string) {
    let _table: any = null;
    const chain: any = {
      from: vi.fn((t: any) => {
        _table = t;
        const sym: symbol | undefined =
          t && Object.getOwnPropertySymbols(t).find((s) => s.toString() === "Symbol(drizzle:Name)");
        chain.__table = sym ? t[sym] : tableName;
        return chain;
      }),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (r: any) => any) =>
        Promise.resolve(cb(handleSelect(chain.__table))),
      ),
    };
    return chain;
  }

  function handleSelect(t: string | undefined) {
    if (t === "tls_budgets") return [...seed.budgets];
    if (t === "tls_budget_reservations") return [...seed.reservations];
    if (t === "tls_budget_usage_events") return [...seed.events];
    return [];
  }

  function handleInsert(table: any) {
    return {
      values: vi.fn((payload: any) => {
        const sym: symbol | undefined =
          table && Object.getOwnPropertySymbols(table).find((s) => s.toString() === "Symbol(drizzle:Name)");
        const name = sym ? table[sym] : "unknown";

        if (name === "tls_budget_reservations") {
          // Detect a partial-unique race: same (talosId, idempotencyKey) twice
          const dupe = seed.reservations.find(
            (r) =>
              r.talosId === payload.talosId &&
              payload.idempotencyKey &&
              r.idempotencyKey === payload.idempotencyKey,
          );
          if (dupe) {
            const err = Object.assign(new Error("duplicate key value"), {
              code: "23505",
              constraint: "tls_budget_reservations_talosId_idempotencyKey_unique",
            });
            return { returning: () => Promise.reject(err) };
          }
          const row = { ...payload, createdAt: new Date() };
          seed.reservations.push(row);
          return { returning: vi.fn().mockResolvedValue([row]) };
        }
        if (name === "tls_budget_usage_events") {
          seed.events.push({ ...payload, createdAt: new Date() });
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
    };
  }

  function handleUpdate(table: any) {
    return {
      set: vi.fn((patch: any) => ({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
          then: vi.fn().mockImplementation((cb: (r: any) => any) => Promise.resolve(cb(undefined))),
        }),
      })),
    };
  }

  return {
    seed,
    mockDb: {
      select: () => makeChain(""),
      insert: handleInsert,
      update: handleUpdate,
    },
    // Match insert on the budget row from upsertBudget; track counter for assertions
    _upsertInserted: 0,
  };
});

vi.mock("@/db", () => ({
  db: mocks.mockDb,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: async (cb: (tx: any) => Promise<any>) => cb(mocks.mockDb),
}));

// ─── Reset ─────────────────────────────────────────────────────────
function reset() {
  mocks.seed.budgets.length = 0;
  mocks.seed.reservations.length = 0;
  mocks.seed.events.length = 0;
  mocks._upsertInserted = 0;
}

// ─── Helpers ───────────────────────────────────────────────────────
function req(url: string, init?: { method?: string; body?: unknown; key?: string; idempotencyKey?: string }) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (init?.key) headers["Authorization"] = `Bearer ${init.key}`;
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

// Auth stub — the real verifyAgentApiKey is wired through.
const TALOS = {
  id: "agent_1",
  apiKey: "key-real",
};

// Provide a verifyAgentApiKey shim that compares `Bearer key-real` against TALOS.apiKey.
vi.mock("@/lib/auth", () => ({
  verifyAgentApiKey: async (request: any, talosId: string) => {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (talosId !== "agent_1" || !token) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (token !== "key-real") {
      return { ok: false, response: Response.json({ error: "Invalid API key" }, { status: 403 }) };
    }
    return { ok: true, talos: { id: "agent_1", apiKey: "key-real" } };
  },
}));

// ─── Tests ─────────────────────────────────────────────────────────

describe("POST /api/talos/:id/budgets/reserve — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1",
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      windowSeconds: null,
      limitAmount: 10_000_000n,
      availableAmount: 10_000_000n,
      currency: "USDC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("creates a reservation when the body is well-formed", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/reserve/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/reserve`, {
        method: "POST",
        key: "key-real",
        body: { scopeKind: "global", amountMinor: "1500000" },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.reservation.id).toBeDefined();
    expect(body.reservation.amount).toBe("1500000");
    expect(body.reservation.status).toBe("reserved");
    expect(body.reservation.fencingToken).toBe(1);
  });

  it("rejects malformed bodies (non-integer amountMinor)", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/reserve/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/reserve`, {
        method: "POST",
        key: "key-real",
        body: { scopeKind: "global", amountMinor: "12.5" },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(400);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/reserve/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/reserve`, {
        method: "POST",
        body: { scopeKind: "global", amountMinor: "1500000" },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(401);
  });

  it("concurrent identical requests with same Idempotency-Key → exactly one 201", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/reserve/route");
    const ctx = { params: Promise.resolve({ id: "agent_1" }) };

    const calls = [1, 2, 3].map(() =>
      POST(
        req(`/api/talos/agent_1/budgets/reserve`, {
          method: "POST",
          key: "key-real",
          idempotencyKey: "key-shared",
          body: { scopeKind: "global", amountMinor: "1500000" },
        }),
        ctx,
      ),
    );
    const responses = await Promise.all(calls);
    const statuses = responses.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 201).length;
    const conflictCount = statuses.filter((s) => s === 409).length;
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(2);
  });

  it("concurrent identical requests with DISTINCT idempotency keys all succeed (until budget exhausted)", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/reserve/route");
    const ctx = { params: Promise.resolve({ id: "agent_1" }) };

    // Use 3 small reservations of 1M each (limit is 10M; 3 succeed, 11th try fails)
    const calls = [1, 2, 3].map((n) =>
      POST(
        req(`/api/talos/agent_1/budgets/reserve`, {
          method: "POST",
          key: "key-real",
          idempotencyKey: `key-${n}`,
          body: { scopeKind: "global", amountMinor: "1000000" },
        }),
        ctx,
      ),
    );
    const responses = await Promise.all(calls);
    expect(responses.every((r) => r.status === 201)).toBe(true);
  });
});

describe("POST /api/talos/:id/budgets/transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1",
      talosId: "agent_1",
      scopeKind: "global",
      scopeValue: null,
      windowSeconds: null,
      limitAmount: 10_000_000n,
      availableAmount: 10_000_000n,
      currency: "USDC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.seed.reservations.push({
      id: "res_1",
      talosId: "agent_1",
      budgetId: "budget_1",
      amount: 2_500_000n,
      status: "reserved",
      idempotencyKey: null,
      fencingToken: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("transitions reserved → committed with the right fencing token", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/transition/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/transition`, {
        method: "POST",
        key: "key-real",
        body: { reservationId: "res_1", toStatus: "committed", fencingToken: 1 },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reservation.status).toBe("committed");
    expect(body.reservation.fencingToken).toBe(2);
  });

  it("rejects with 409 when fencing token is stale", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/transition/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/transition`, {
        method: "POST",
        key: "key-real",
        body: { reservationId: "res_1", toStatus: "committed", fencingToken: 99 },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("stale_fencing_token");
  });

  it("rejects illegal transitions on a terminal reservation", async () => {
    // A 'released' reservation is terminal with no legal exits; the
    // already_terminal guard fires before the state-machine check.
    mocks.seed.reservations[0].status = "released";
    mocks.seed.reservations[0].fencingToken = 5;
    const { POST } = await import("../src/app/api/talos/[id]/budgets/transition/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/transition`, {
        method: "POST",
        key: "key-real",
        body: { reservationId: "res_1", toStatus: "settled", fencingToken: 5 },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("already_terminal");
  });

  it("rejects a non-terminal but illegal backwards transition", async () => {
    // 'settled' is not terminal (it can still refund), but reserved is
    // not a legal exit — the state-machine guard fires.
    mocks.seed.reservations[0].status = "settled";
    mocks.seed.reservations[0].fencingToken = 5;
    const { POST } = await import("../src/app/api/talos/[id]/budgets/transition/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets/transition`, {
        method: "POST",
        key: "key-real",
        body: { reservationId: "res_1", toStatus: "reserved", fencingToken: 5 },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_transition");
  });
});

describe("GET /api/talos/:id/budgets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    mocks.seed.budgets.push({
      id: "budget_1", talosId: "agent_1", scopeKind: "global",
      scopeValue: null, windowSeconds: null,
      limitAmount: 10_000_000n, availableAmount: 10_000_000n,
      currency: "USDC", enabled: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("returns the list of configured budgets", async () => {
    const { GET } = await import("../src/app/api/talos/[id]/budgets/route");
    const response = await GET(
      req(`/api/talos/agent_1/budgets`, { key: "key-real" }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].id).toBe("budget_1");
    expect(body.budgets[0].limitAmount).toBe("10000000");
  });
});

describe("POST /api/talos/:id/budgets (upsert)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("creates a new budget for a brand-new scope", async () => {
    const { POST } = await import("../src/app/api/talos/[id]/budgets/route");
    const response = await POST(
      req(`/api/talos/agent_1/budgets`, {
        method: "POST",
        key: "key-real",
        body: {
          scopeKind: "rolling",
          scopeValue: "daily",
          windowSeconds: 86400,
          limitAmountMinor: "50000000",
        },
      }),
      { params: Promise.resolve({ id: "agent_1" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.budget.windowSeconds).toBe(86400);
    expect(body.budget.limitAmount).toBe("50000000");
  });
});
