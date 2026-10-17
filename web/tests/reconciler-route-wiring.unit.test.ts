/**
 * Unit tests: reconciler wiring in buy-token and jobs routes
 *
 * Coverage matrix
 * ───────────────
 * buy-token route
 *   ✓ happy-path — registerTx() is called after a successful purchase
 *   ✓ registerTx() is called with sourceType="token_purchase" and sourceId=txHash
 *   ✓ registerTx() failure does NOT cause the route to return an error
 *   ✓ idempotent replay (existing "completed" purchase) — registerTx() is NOT called
 *   ✓ failed Talos lookup — registerTx() is NOT called
 *
 * jobs route (async fulfillment path)
 *   ✓ happy-path — registerTx() is called after a new async job is created
 *   ✓ registerTx() is called with sourceType="commerce_job" and sourceId=jobId
 *   ✓ registerTx() failure does NOT cause the route to return an error
 *   ✓ txHash replay (duplicate job) — registerTx() is NOT called
 *   ✓ instant-fulfillment jobs — registerTx() is NOT called
 *   ✓ missing buyerPublicKey — 400, registerTx() is NOT called
 *
 * boundary / regression
 *   ✓ expiresAt is set to a future date (>= 1 h from now) for both source types
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
// Must be declared before any vi.mock() calls so the factory closure captures
// the correct references.

const mocks = vi.hoisted(() => ({
  mockRegisterTx: vi.fn().mockResolvedValue("rec_fake_id"),
  mockFulfillInstant: vi.fn(),
  mockCheckAndIncrementQuota: vi.fn().mockResolvedValue({ ok: true, remaining: 99 }),
  mockApplyQuotaHeaders: vi.fn((res: Response) => res),
  mockQuotaExceededResponse: vi.fn(),
  mockIngestJobToLedger: vi.fn().mockResolvedValue(null),
  mockGetAccountInfo: vi.fn().mockResolvedValue({ exists: true }),
  mockGetNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
  mockGetUSDCIssuer: vi.fn(() => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockWithTxRetry: vi.fn(),
  // DB query result stores — set per-test
  _talosRow: null as any,
  _existingPurchaseRow: null as any,
  _patronRow: null as any,
  _selectResults: [] as any[],
  _selectCallCount: 0,
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/reconciler", () => ({
  registerTx: (...args: any[]) => mocks.mockRegisterTx(...args),
}));

vi.mock("@/db/db-retry", () => ({
  withTransactionRetry: (...args: any[]) => mocks.mockWithTxRetry(...args),
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: (...args: any[]) => mocks.mockFulfillInstant(...args),
}));

vi.mock("@/lib/quota", () => ({
  checkAndIncrementQuota: (...args: any[]) => mocks.mockCheckAndIncrementQuota(...args),
  applyQuotaHeaders: (...args: any[]) => mocks.mockApplyQuotaHeaders(...args),
  quotaExceededResponse: (...args: any[]) => mocks.mockQuotaExceededResponse(...args),
}));

vi.mock("@/lib/reputation-ledger", () => ({
  ingestJobToLedger: (...args: any[]) => mocks.mockIngestJobToLedger(...args),
}));

vi.mock("@/lib/stellar", () => ({
  getAccountInfo: (...args: any[]) => mocks.mockGetAccountInfo(...args),
  getNetworkPassphrase: () => mocks.mockGetNetworkPassphrase(),
  getUSDCIssuer: () => mocks.mockGetUSDCIssuer(),
}));

vi.mock("@/lib/stellar-config", () => ({
  OPERATOR_PUBLIC_KEY: "GCOPERATOR000000000000000000000000000000000000000000000001",
  USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
}));

// DB mock — supports both db.query.* (buy-token) and db.select() chain (jobs)
vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: {
        findFirst: () => Promise.resolve(mocks._talosRow),
      },
      tlsTokenPurchases: {
        findFirst: () => Promise.resolve(mocks._existingPurchaseRow),
      },
      tlsPatrons: {
        findFirst: () => Promise.resolve(mocks._patronRow),
      },
    },
    select: vi.fn(() => {
      const callIndex = mocks._selectCallCount++;
      const row = mocks._selectResults[callIndex] ?? [];
      const chain: any = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: (r: any[]) => any) => cb(row)),
      };
      return chain;
    }),
    insert: (...args: any[]) => mocks.mockInsert(...args),
    update: (...args: any[]) => mocks.mockUpdate(...args),
  },
}));

// Stellar SDK — provides a fake server that returns a successful tx with a
// valid USDC payment op so buy-token verification passes.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const BUYER_PK = "GDBUYER000000000000000000000000000000000000000000000000001";
  const OPERATOR_PK = "GCOPERATOR000000000000000000000000000000000000000000000001";

  const fakeTxRecord = {
    successful: true,
    envelope_xdr: "fake_xdr",
    source_account: BUYER_PK,
    ledger: 1001,
  };

  const fakeTx = {
    source: BUYER_PK,
    operations: [
      {
        type: "payment",
        asset: { code: "USDC", issuer: USDC_ISSUER },
        destination: OPERATOR_PK,
        amount: "10.000000",
      },
    ],
  };

  return {
    ...original,
    Horizon: {
      Server: class {
        transactions() {
          return {
            transaction: (_hash: string) => ({
              call: () => Promise.resolve(fakeTxRecord),
            }),
          };
        }
        loadAccount(pk: string) {
          const { Account } = original;
          return Promise.resolve(new Account(pk, "100"));
        }
        submitTransaction() {
          return Promise.resolve({ hash: "mitos_out_hash" });
        }
      },
    },
    TransactionBuilder: {
      ...original.TransactionBuilder,
      fromXDR: () => fakeTx,
    },
  };
});

// ─── Route imports (after all vi.mock() calls) ────────────────────────────────

import { POST as buyTokenPOST } from "../src/app/api/talos/[id]/buy-token/route";
import { POST as jobsPOST } from "../src/app/api/talos/[id]/jobs/route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TALOS_ID = "talos_test_001";
const BUYER_PK = "GDBUYER000000000000000000000000000000000000000000000000001";
const TX_HASH = "aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd11223344";
const JOB_ID = "job_test_999";

function makeTalos(overrides: Record<string, unknown> = {}) {
  return {
    id: TALOS_ID,
    status: "Active",
    agentOnline: true,
    name: "Test Agent",
    agentWalletAddress: null,
    pulsePrice: "10.0",
    minPatronPulse: 100,
    stellarAssetCode: null,
    tokenSymbol: "MITOS",
    ...overrides,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc_1",
    talosId: TALOS_ID,
    serviceName: "test_service",
    price: "10.000000",
    currency: "USDC",
    stellarPublicKey: "GCOPERATOR000000000000000000000000000000000000000000000001",
    fulfillmentMode: "async",
    ...overrides,
  };
}

function buyReq(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/talos/${TALOS_ID}/buy-token`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function jobsReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/talos/${TALOS_ID}/jobs`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ─── Buy-token route: registerTx wiring ──────────────────────────────────────

describe("buy-token route — reconciler wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks._selectCallCount = 0;
    mocks._selectResults = [];
    mocks.mockRegisterTx.mockResolvedValue("rec_id");
    mocks._talosRow = makeTalos();
    mocks._existingPurchaseRow = null;
    mocks._patronRow = null;

    // Insert chain: insert pending row
    mocks.mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });

    // Update chain
    mocks.mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    });

    // withTransactionRetry — simulate the atomic transaction block
    mocks.mockWithTxRetry.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
      cb({
        insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
        update: () => ({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    );
  });

  it("calls registerTx with sourceType=token_purchase and sourceId=txHash after successful purchase", async () => {
    const res = await buyTokenPOST(buyReq({ buyerPublicKey: BUYER_PK, amount: 1, txHash: TX_HASH }), {
      params: Promise.resolve({ id: TALOS_ID }),
    });

    expect(res.status).toBe(200);
    expect(mocks.mockRegisterTx).toHaveBeenCalledOnce();
    expect(mocks.mockRegisterTx).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        sourceType: "token_purchase",
        sourceId: TX_HASH,
      }),
    );
  });

  it("expiresAt is a future date (>= 1 h from now)", async () => {
    const beforeCall = Date.now();
    await buyTokenPOST(buyReq({ buyerPublicKey: BUYER_PK, amount: 1, txHash: TX_HASH }), {
      params: Promise.resolve({ id: TALOS_ID }),
    });

    const call = mocks.mockRegisterTx.mock.calls[0]?.[0];
    expect(call?.expiresAt).toBeInstanceOf(Date);
    expect((call.expiresAt as Date).getTime()).toBeGreaterThan(beforeCall + 59 * 60 * 1000);
  });

  it("a registerTx() rejection does NOT cause the route to return an error (fire-and-forget)", async () => {
    mocks.mockRegisterTx.mockRejectedValue(new Error("DB unavailable"));

    const res = await buyTokenPOST(buyReq({ buyerPublicKey: BUYER_PK, amount: 1, txHash: TX_HASH }), {
      params: Promise.resolve({ id: TALOS_ID }),
    });

    // Route must still return 200 — reconciler failure is non-blocking
    expect(res.status).toBe(200);
  });

  it("does NOT call registerTx() for an idempotent replay of a completed purchase", async () => {
    mocks._existingPurchaseRow = {
      txHash: TX_HASH,
      talosId: TALOS_ID,
      status: "completed",
      responseBody: { success: true, txHash: TX_HASH },
    };

    const res = await buyTokenPOST(buyReq({ buyerPublicKey: BUYER_PK, amount: 1, txHash: TX_HASH }), {
      params: Promise.resolve({ id: TALOS_ID }),
    });

    expect(res.status).toBe(200);
    expect(mocks.mockRegisterTx).not.toHaveBeenCalled();
  });

  it("does NOT call registerTx() when the Talos is not found", async () => {
    mocks._talosRow = null;

    const res = await buyTokenPOST(buyReq({ buyerPublicKey: BUYER_PK, amount: 1, txHash: TX_HASH }), {
      params: Promise.resolve({ id: TALOS_ID }),
    });

    expect(res.status).toBe(404);
    expect(mocks.mockRegisterTx).not.toHaveBeenCalled();
  });
});

// ─── Jobs route: registerTx wiring ───────────────────────────────────────────

describe("jobs route — reconciler wiring", () => {
  // select() call order in POST /jobs:
  //   Promise.all => [0] service query, [1] talos query
  //   [2] idempotency key lookup
  //   [3] txHash dupe check
  function setupSelectResults({
    service = makeService(),
    talos = makeTalos(),
    idempotencyRow = [] as any[],
    dupeRow = [] as any[],
  } = {}) {
    mocks._selectCallCount = 0;
    mocks._selectResults = [
      service ? [service] : [],
      talos ? [talos] : [],
      idempotencyRow,
      dupeRow,
    ];
  }

  function makeJobInsert() {
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: JOB_ID, talosId: TALOS_ID }]),
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockRegisterTx.mockResolvedValue("rec_id");
    setupSelectResults();

    mocks.mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    });

    // withTransactionRetry — returns inserted job id
    mocks.mockWithTxRetry.mockImplementation(async (cb: (tx: any) => Promise<any>) => {
      const fakeTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: JOB_ID, talosId: TALOS_ID }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return cb(fakeTx);
    });
  });

  it("calls registerTx with sourceType=commerce_job and sourceId=jobId for async jobs", async () => {
    const res = await jobsPOST(
      jobsReq({ buyerPublicKey: BUYER_PK, txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );

    expect(res.status).toBe(201);
    expect(mocks.mockRegisterTx).toHaveBeenCalledOnce();
    expect(mocks.mockRegisterTx).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash: TX_HASH,
        sourceType: "commerce_job",
        sourceId: JOB_ID,
      }),
    );
  });

  it("expiresAt is set to a future date for commerce_job registration", async () => {
    const beforeCall = Date.now();
    await jobsPOST(
      jobsReq({ buyerPublicKey: BUYER_PK, txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );

    const call = mocks.mockRegisterTx.mock.calls[0]?.[0];
    expect(call?.expiresAt).toBeInstanceOf(Date);
    expect((call.expiresAt as Date).getTime()).toBeGreaterThan(beforeCall + 59 * 60 * 1000);
  });

  it("a registerTx() rejection does NOT cause the jobs route to return an error (fire-and-forget)", async () => {
    mocks.mockRegisterTx.mockRejectedValue(new Error("reconciler unavailable"));

    const res = await jobsPOST(
      jobsReq({ buyerPublicKey: BUYER_PK, txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );

    expect(res.status).toBe(201);
  });

  it("does NOT call registerTx() for instant-fulfillment jobs", async () => {
    setupSelectResults({ service: makeService({ fulfillmentMode: "instant" }) });
    mocks.mockFulfillInstant.mockResolvedValue({ output: "done" });

    const res = await jobsPOST(
      jobsReq({ buyerPublicKey: BUYER_PK, txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );

    expect(res.status).toBe(201);
    expect(mocks.mockRegisterTx).not.toHaveBeenCalled();
  });

  it("does NOT call registerTx() when the txHash is already used (replay)", async () => {
    // Dupe check returns an existing row → 409
    setupSelectResults({ dupeRow: [{ id: "existing_job" }] });

    const res = await jobsPOST(
      jobsReq({ buyerPublicKey: BUYER_PK, txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );

    expect(res.status).toBe(409);
    expect(mocks.mockRegisterTx).not.toHaveBeenCalled();
  });

  it("returns 400 and does NOT call registerTx() when buyerPublicKey is missing", async () => {
    const res = await jobsPOST(
      jobsReq({ txHash: TX_HASH }),
      { params: Promise.resolve({ id: TALOS_ID }) },
    );
    expect(res.status).toBe(400);
    expect(mocks.mockRegisterTx).not.toHaveBeenCalled();
  });
});
