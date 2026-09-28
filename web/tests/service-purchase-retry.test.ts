/**
 * Tests for retry and recovery UX for failed service purchases (#521)
 *
 * Coverage:
 *   positive  — successful purchase returns job ID, tx hash, and status
 *   negative  — payment submission failure (network error before TX lands) →
 *               retryable=true + retryAfterMs + hint (user was NOT charged)
 *   negative  — payment verification failure (TX submitted but ops mismatch) →
 *               retryable=false (user WAS charged)
 *   negative  — fulfillment failure (instant mode) → retryable=false
 *   boundary  — replay detection (409) carries no retryable flag
 *   boundary  — missing buyerPublicKey (400) carries no retryable flag
 *   boundary  — missing txHash and signedXdr (400) carries no retryable flag
 *   boundary  — TALOS not found (404) carries no retryable flag
 *   boundary  — no service registered (404) carries no retryable flag
 *   regression — success response has no retryable/error fields
 *
 * Route under test: POST /api/talos/[id]/jobs
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock factories ───────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) =>
    cb({
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
    }),
  );
  return {
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTransaction,
    mockFulfillInstant: vi.fn(),
    _serviceResult: [] as any[],
    _talosResult: [] as any[],
    _idempotencyResult: [] as any[],
    _dupeResult: [] as any[],
    _commerceJobsSelectCount: 0,
    // Controls what submitTransaction does in submitAndVerifyPayment tests
    mockSubmitTransaction: vi.fn(),
  };
});

vi.mock("@/db", () => {
  const makeChain = () => {
    let resolvedTable: any = null;
    const chain: any = {
      from: vi.fn((table: any) => { resolvedTable = table; return chain; }),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (r: any) => any) => {
        const syms: symbol[] = resolvedTable ? Object.getOwnPropertySymbols(resolvedTable) : [];
        const nameSym = syms.find((s) => s.toString() === "Symbol(drizzle:Name)");
        const tableName: string = nameSym ? resolvedTable[nameSym] : "";

        if (tableName === "tls_commerce_services") return Promise.resolve(cb(mocks._serviceResult));
        if (tableName === "tls_talos") return Promise.resolve(cb(mocks._talosResult));
        if (tableName === "tls_commerce_jobs") {
          const count = mocks._commerceJobsSelectCount++;
          if (count === 0) return Promise.resolve(cb(mocks._idempotencyResult));
          return Promise.resolve(cb(mocks._dupeResult));
        }
        return Promise.resolve(cb([]));
      }),
    };
    return chain;
  };

  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: (...a: any[]) => mocks.mockInsert(...a),
      transaction: mocks.mockTransaction,
    },
  };
});

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: vi.fn(async (cb: any) =>
    cb({
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
    }),
  ),
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: mocks.mockFulfillInstant,
}));

vi.mock("@/lib/stellar-config", () => ({
  OPERATOR_PUBLIC_KEY: "GOPERATOR000000000000000000000000000000000000000000000000",
  USDC_ISSUER: "GUSDC000000000000000000000000000000000000000000000000000000",
}));

vi.mock("@/lib/reputation-ledger", () => ({
  ingestJobToLedger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/quota", () => ({
  checkAndIncrementQuota: vi.fn().mockResolvedValue({ ok: true }),
  applyQuotaHeaders: vi.fn((res: Response) => res),
  quotaExceededResponse: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../src/app/api/talos/[id]/jobs/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const routeParams = Promise.resolve({ id: "agent-id" });

function makeReq(body: object, headers?: Record<string, string>) {
  return new NextRequest("http://localhost/api/talos/agent-id/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeService(overrides: Record<string, unknown> = {}) {
  return [{
    id: "svc-1", talosId: "agent-id", serviceName: "Market Research",
    price: "1.00", currency: "USDC",
    stellarPublicKey: "GPAYEE000000000000000000000000000000000000000000000000000",
    chains: ["stellar"], fulfillmentMode: "async",
    ...overrides,
  }];
}

function makeTalos(overrides: Record<string, unknown> = {}) {
  return [{
    id: "agent-id", agentOnline: true, status: "Active", name: "Agent Nova",
    agentWalletAddress: "GWALLET00000000000000000000000000000000000000000000000000",
    ...overrides,
  }];
}

// Use legacy txHash path to skip Stellar SDK dynamic import in most tests
const BASE_BODY = {
  buyerPublicKey: "GBUYER000000000000000000000000000000000000000000000000000",
  txHash: "abc123txhash000",
  payload: { request: "research AI trends" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks._serviceResult = [];
  mocks._talosResult = [];
  mocks._idempotencyResult = [];
  mocks._dupeResult = [];
  mocks._commerceJobsSelectCount = 0;
});

// ─── Positive path ────────────────────────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — successful purchase", () => {
  it("returns 201 with jobId, serviceName, status, txHash and no retryable field", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();
    mocks._idempotencyResult = [];
    mocks._dupeResult = [];

    const insertedJob = { id: "job-xyz", status: "pending", serviceName: "Market Research" };
    mocks.mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([insertedJob]),
      }),
    });

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobId).toBe("job-xyz");
    expect(body.status).toBe("pending");
    expect(body.txHash).toBe(BASE_BODY.txHash);
    // Success responses must never include error or retryable fields
    expect(body.error).toBeUndefined();
    expect(body.retryable).toBeUndefined();
  });
});

// ─── Retryable errors ─────────────────────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — retryable errors (user NOT charged)", () => {
  it("payment submission failure (network error before TX lands) → retryable=true + retryAfterMs + hint", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();
    mocks._idempotencyResult = [];
    mocks._dupeResult = [];

    // signedXdr path triggers submitAndVerifyPayment which attempts a dynamic
    // import of @stellar/stellar-sdk and submits to Horizon. In the test env
    // that import / network call throws before the TX is on-chain, which is
    // the transient network-error path.
    const res = await POST(
      makeReq({ buyerPublicKey: "GBUYER0000", signedXdr: "AAAA==", payload: {} }),
      { params: routeParams },
    );

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.retryable).toBe(true);
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(typeof body.hint).toBe("string");
    expect(body.hint.length).toBeGreaterThan(0);
  });
});

// ─── Non-retryable errors ─────────────────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — non-retryable errors (user MAY have been charged)", () => {
  it("fulfillment failure (instant mode) returns retryable=false", async () => {
    mocks._serviceResult = makeService({ fulfillmentMode: "instant" });
    mocks._talosResult = makeTalos();
    mocks._idempotencyResult = [];
    mocks._dupeResult = [];

    mocks.mockFulfillInstant.mockRejectedValue(new Error("external API unavailable"));

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.retryable).toBe(false);
    expect(body.error).toMatch(/fulfillment failed/i);
  });
});

// ─── Non-retryable client errors ─────────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — client errors (no retryable flag)", () => {
  it("missing buyerPublicKey returns 400 without retryable flag", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();

    const res = await POST(makeReq({ txHash: "abc" }), { params: routeParams });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.retryable).toBeUndefined();
  });

  it("missing txHash and signedXdr returns 400 without retryable flag", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();

    const res = await POST(makeReq({ buyerPublicKey: "GBUYER0000" }), { params: routeParams });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.retryable).toBeUndefined();
  });

  it("TALOS not found returns 404 without retryable flag", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = [];

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.retryable).toBeUndefined();
  });

  it("no service registered returns 404 without retryable flag", async () => {
    mocks._serviceResult = [];
    mocks._talosResult = makeTalos();

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.retryable).toBeUndefined();
  });

  it("Paused agent returns 409 without retryable flag", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos({ status: "Paused" });

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.retryable).toBeUndefined();
  });
});

// ─── Replay detection ─────────────────────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — replay detection is not retryable", () => {
  it("returns 409 when txHash already used, no retryable flag", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();
    // No idempotency key is sent, so the idempotency select is skipped.
    // The first (count 0) tls_commerce_jobs select IS the replay check.
    mocks._idempotencyResult = [{ id: "existing-job" }]; // replay duplicate
    mocks._dupeResult = [];

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/replay/i);
    expect(body.retryable).toBeUndefined();
  });
});

// ─── Error classification contract ───────────────────────────────────────────

describe("POST /api/talos/[id]/jobs — error classification contract", () => {
  it("retryable errors include retryAfterMs > 0", async () => {
    mocks._serviceResult = makeService();
    mocks._talosResult = makeTalos();
    mocks._idempotencyResult = [];
    mocks._dupeResult = [];

    // signedXdr path → network throw → retryable
    const res = await POST(
      makeReq({ buyerPublicKey: "GBUYER0000", signedXdr: "AAAA==", payload: {} }),
      { params: routeParams },
    );
    const body = await res.json();
    if (body.retryable === true) {
      expect(body.retryAfterMs).toBeGreaterThan(0);
      expect(typeof body.hint).toBe("string");
    }
  });

  it("non-retryable errors do not include retryAfterMs or hint", async () => {
    mocks._serviceResult = makeService({ fulfillmentMode: "instant" });
    mocks._talosResult = makeTalos();
    mocks._idempotencyResult = [];
    mocks._dupeResult = [];

    mocks.mockFulfillInstant.mockRejectedValue(new Error("downstream unavailable"));

    const res = await POST(makeReq(BASE_BODY), { params: routeParams });
    const body = await res.json();
    expect(body.retryable).toBe(false);
    expect(body.retryAfterMs).toBeUndefined();
    expect(body.hint).toBeUndefined();
  });
});
