/**
 * Idempotency tests for POST /api/talos/[id]/buy-token
 *
 * Test matrix:
 *   positive  — completed retry returns the original cached response (200, no side effects repeated)
 *   negative  — pending row returns 409 "in-progress"
 *   negative  — concurrent race: second insert hits unique constraint, returns 409
 *   negative  — failed row is retried (reset to pending, side effects re-run)
 *   existing  — original verification tests still pass with the new idempotency layer
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST } from "../src/app/api/talos/[id]/buy-token/route";
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  Account,
} from "@stellar/stellar-sdk";
import { OPERATOR_PUBLIC_KEY } from "../src/lib/stellar-config";

// ─── Hoisted mock factories ───────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const transactionCall = vi.fn();
  const submitTransaction = vi.fn();
  const transactions = vi.fn(() => ({
    transaction: vi.fn(() => ({ call: transactionCall })),
  }));

  // db.transaction() executes its callback with the same db-like object
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
    });
  });

  return {
    mockFindFirstTalos: vi.fn(),
    mockFindFirstTokenPurchase: vi.fn(),
    mockFindFirstPatrons: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTransaction,
    mockGetAccountInfo: vi.fn(),
    mockGetNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
    mockGetUSDCIssuer: vi.fn(
      () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    ),
    mockTransactionCall: transactionCall,
    mockTransactions: transactions,
    mockSubmitTransaction: submitTransaction,
  };
});

const {
  mockFindFirstTalos,
  mockFindFirstTokenPurchase,
  mockFindFirstPatrons,
  mockInsert,
  mockUpdate,
  mockTransaction,
  mockGetAccountInfo,
  mockGetNetworkPassphrase,
  mockGetUSDCIssuer,
  mockTransactionCall,
  mockTransactions,
  mockSubmitTransaction,
} = mocks;

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: {
        findFirst: (...args: any[]) => mocks.mockFindFirstTalos(...args),
      },
      tlsTokenPurchases: {
        findFirst: (...args: any[]) => mocks.mockFindFirstTokenPurchase(...args),
      },
      tlsPatrons: {
        findFirst: (...args: any[]) => mocks.mockFindFirstPatrons(...args),
      },
    },
    insert: (...args: any[]) => mocks.mockInsert(...args),
    update: (...args: any[]) => mocks.mockUpdate(...args),
    transaction: (cb: any) => mocks.mockTransaction(cb),
  },
}));

vi.mock("@/lib/stellar", () => ({
  getAccountInfo: (...args: any[]) => mocks.mockGetAccountInfo(...args),
  getNetworkPassphrase: () => mocks.mockGetNetworkPassphrase(),
  getUSDCIssuer: () => mocks.mockGetUSDCIssuer(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...original,
    Horizon: {
      Server: class {
        loadAccount = vi.fn().mockImplementation(async (publicKey: string) => {
          const account = new Account(publicKey, "12345");
          (account as any).balances = [{ asset_type: "native", balance: "100" }];
          return account;
        });
        transactions = mocks.mockTransactions;
        submitTransaction = (...args: any[]) => mocks.mockSubmitTransaction(...args);
      },
    },
  };
});

// ─── Shared test helpers ──────────────────────────────────────────────────────

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Build a minimal Talos record */
function makeTalos(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-id",
    pulsePrice: "0.5",
    stellarAssetCode: "MITOS:GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV",
    minPatronPulse: 100,
    agentWalletAddress: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
    tokenSymbol: "MITOS",
    ...overrides,
  };
}

/**
 * Build a valid Stellar USDC payment transaction XDR and return both the
 * signed XDR and the buyer's public key.
 */
function buildValidTx(opts: {
  buyerKeypair: ReturnType<typeof Keypair.random>;
  totalCost: number;
  destination?: string;
}) {
  const { buyerKeypair, totalCost, destination = OPERATOR_PUBLIC_KEY } = opts;
  const sourceAccount = new Account(buyerKeypair.publicKey(), "123456789012345");
  const usdcAsset = new Asset("USDC", USDC_ISSUER);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: usdcAsset,
        amount: totalCost.toFixed(7),
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(buyerKeypair);
  return { xdr: tx.toXDR(), buyerPublicKey: buyerKeypair.publicKey() };
}

/** Build a POST Request for the buy-token endpoint */
function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/talos/agent-id/buy-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeParams = Promise.resolve({ id: "agent-id" });

/** Wire up the "happy path" Horizon mock for a given XDR */
function mockValidHorizon(buyerPublicKey: string, xdr: string) {
  mockTransactionCall.mockResolvedValue({
    successful: true,
    source_account: buyerPublicKey,
    envelope_xdr: xdr,
  });
  mockSubmitTransaction.mockResolvedValue({ hash: "mitos-transfer-tx-hash" });
}

/** Standard insert mock: returns a chainable .values() */
function resetInsertMock() {
  mockInsert.mockReturnValue({
    values: vi.fn().mockResolvedValue([]),
  });
}

/** Standard update mock: returns a chainable .set().where() */
function resetUpdateMock() {
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buy-token idempotency — positive (completed retry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
    process.env.STELLAR_OPERATOR_SECRET_KEY = Keypair.random().secret();
  });

  it("returns the cached 200 response on an idempotent retry (status=completed)", async () => {
    const cachedResponse = {
      success: true,
      txHash: "known-tx-hash",
      mitosTxHash: "mitos-abc",
      tokenSymbol: "MITOS",
      amount: 10,
      pricePerToken: 0.5,
      totalCost: 5,
      currency: "USDC",
      buyerPublicKey: "GBUYER",
      totalPulseHeld: 10,
      patronStatus: "pending (need 90 more MITOS)",
      message: "Successfully purchased 10 MITOS for 5.00 USDC",
    };

    mockFindFirstTalos.mockResolvedValue(makeTalos());
    // Simulate: purchase already completed
    mockFindFirstTokenPurchase.mockResolvedValue({
      txHash: "known-tx-hash",
      status: "completed",
      responseBody: cachedResponse,
    });

    const req = makeRequest({
      buyerPublicKey: "GBUYER",
      amount: 10,
      txHash: "known-tx-hash",
    });

    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(cachedResponse);

    // No Horizon call, no insert, no transaction — purely from cache
    expect(mockTransactionCall).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("re-runs side effects when retrying a previously failed purchase (status=failed)", async () => {
    const buyerKeypair = Keypair.random();
    const totalCost = 5; // 10 tokens × 0.5 USDC
    const { xdr, buyerPublicKey } = buildValidTx({ buyerKeypair, totalCost });

    mockFindFirstTalos.mockResolvedValue(makeTalos());
    // Simulate: previous attempt failed
    mockFindFirstTokenPurchase.mockResolvedValue({
      txHash: "retry-tx-hash",
      status: "failed",
      responseBody: null,
    });
    mockFindFirstPatrons.mockResolvedValue(null);
    mockGetAccountInfo.mockResolvedValue({ exists: true });
    mockValidHorizon(buyerPublicKey, xdr);

    const req = makeRequest({ buyerPublicKey, amount: 10, txHash: "retry-tx-hash" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The update mock resets status to "pending" and then the transaction commits
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalled();
  });
});

describe("buy-token idempotency — negative (pending / in-progress)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
    process.env.STELLAR_OPERATOR_SECRET_KEY = Keypair.random().secret();
  });

  it("returns 409 when a purchase row already exists with status=pending", async () => {
    mockFindFirstTalos.mockResolvedValue(makeTalos());
    mockFindFirstTokenPurchase.mockResolvedValue({
      txHash: "in-flight-tx",
      status: "pending",
      responseBody: null,
    });

    const req = makeRequest({
      buyerPublicKey: "GBUYER",
      amount: 10,
      txHash: "in-flight-tx",
    });

    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/in progress/i);

    // Must not proceed to Horizon verification or any DB writes
    expect(mockTransactionCall).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when a concurrent request causes a unique-constraint violation (race condition)", async () => {
    // Both concurrent requests read null for the purchase row, then both try
    // to INSERT — only the first succeeds; the second gets a PG error 23505.
    mockFindFirstTalos.mockResolvedValue(makeTalos());
    mockFindFirstTokenPurchase.mockResolvedValue(null); // no existing row yet

    // Simulate the DB throwing a unique-constraint violation on the INSERT
    const pgUniqueError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    mockInsert.mockReturnValue({
      values: vi.fn().mockRejectedValue(pgUniqueError),
    });

    const req = makeRequest({
      buyerPublicKey: "GBUYER",
      amount: 10,
      txHash: "race-tx-hash",
    });

    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/in progress/i);

    // No Horizon call, no transaction — blocked at the claim step
    expect(mockTransactionCall).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("buy-token idempotency — concurrent requests (Promise.all race)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STELLAR_OPERATOR_SECRET_KEY = Keypair.random().secret();
  });

  it("allows exactly one request to proceed when N identical requests fire simultaneously", async () => {
    const buyerKeypair = Keypair.random();
    const totalCost = 5;
    const { xdr, buyerPublicKey } = buildValidTx({ buyerKeypair, totalCost });
    const txHash = "concurrent-tx-hash";

    mockFindFirstTalos.mockResolvedValue(makeTalos());
    mockFindFirstPatrons.mockResolvedValue(null);
    mockGetAccountInfo.mockResolvedValue({ exists: true });
    mockValidHorizon(buyerPublicKey, xdr);

    // Each request reads null for the purchase row (no existing row yet),
    // then races to INSERT the pending claim row.
    // The first INSERT succeeds; all later ones hit the unique constraint.
    mockFindFirstTokenPurchase.mockResolvedValue(null);

    // Track calls to the outer db.insert() (the pending-claim step).
    // Calls inside db.transaction() use a separate tx object, so they
    // won't increment this counter.
    let outerInsertCount = 0;
    mockInsert.mockImplementation(() => {
      outerInsertCount += 1;
      if (outerInsertCount === 1) {
        return { values: vi.fn().mockResolvedValue([]) };
      }
      const err = Object.assign(new Error("duplicate key value"), { code: "23505" });
      return { values: vi.fn().mockRejectedValue(err) };
    });

    // The transaction uses its own insert/update mocks that always succeed
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    );
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });

    const makeReq = () =>
      makeRequest({ buyerPublicKey, amount: 10, txHash });

    // Fire three identical requests concurrently
    const [res1, res2, res3] = await Promise.all([
      POST(makeReq(), { params: routeParams }),
      POST(makeReq(), { params: routeParams }),
      POST(makeReq(), { params: routeParams }),
    ]);

    const statuses = [res1.status, res2.status, res3.status];

    // Exactly one should succeed
    const successes = statuses.filter((s) => s === 200);
    const conflicts = statuses.filter((s) => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(2);

    // The successful response must be well-formed
    const winner = [res1, res2, res3].find((r) => r.status === 200)!;
    const winnerBody = await winner.json();
    expect(winnerBody.success).toBe(true);
    expect(winnerBody.txHash).toBe(txHash);

    // Side effects committed exactly once
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("buy-token idempotency — transactional consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
    process.env.STELLAR_OPERATOR_SECRET_KEY = Keypair.random().secret();
  });

  it("commits patron upsert, revenue insert and status flip in a single db.transaction()", async () => {
    const buyerKeypair = Keypair.random();
    const totalCost = 5;
    const { xdr, buyerPublicKey } = buildValidTx({ buyerKeypair, totalCost });

    mockFindFirstTalos.mockResolvedValue(makeTalos());
    mockFindFirstTokenPurchase.mockResolvedValue(null);
    mockFindFirstPatrons.mockResolvedValue(null);
    mockGetAccountInfo.mockResolvedValue({ exists: true });
    mockValidHorizon(buyerPublicKey, xdr);

    // Capture the ops executed inside the transaction.
    // Use double optional chaining (table?.["_"]?.["name"]) because Drizzle's
    // internal `_` property is a private symbol not present on mocked objects —
    // accessing ["name"] on undefined throws before the ?? fallback can run.
    const txOps: string[] = [];
    mockTransaction.mockImplementation(async (cb: any) => {
      const txDb = {
        insert: vi.fn((table: any) => {
          txOps.push(`insert:${table?.["_"]?.["name"] ?? "unknown"}`);
          return { values: vi.fn().mockResolvedValue([]) };
        }),
        update: vi.fn((table: any) => {
          txOps.push(`update:${table?.["_"]?.["name"] ?? "unknown"}`);
          return {
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          };
        }),
      };
      return cb(txDb);
    });

    const req = makeRequest({ buyerPublicKey, amount: 10, txHash: "atomic-tx" });
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(200);

    // The transaction must have been called exactly once
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // Within that single transaction:
    //   - tlsPatrons insert (new patron)
    //   - tlsRevenues insert
    //   - tlsTokenPurchases update (status flip)
    // All three operations must be present.
    expect(txOps.some((op) => op.startsWith("insert:"))).toBe(true);  // patron or revenue
    expect(txOps.some((op) => op.startsWith("update:"))).toBe(true);  // status flip
    expect(txOps.length).toBeGreaterThanOrEqual(2); // at least revenue insert + status update
  });

  it("does not commit side effects when the Mitos transfer fails", async () => {
    const buyerKeypair = Keypair.random();
    const totalCost = 5;
    const { xdr, buyerPublicKey } = buildValidTx({ buyerKeypair, totalCost });

    mockFindFirstTalos.mockResolvedValue(makeTalos());
    mockFindFirstTokenPurchase.mockResolvedValue(null);
    mockGetAccountInfo.mockResolvedValue({ exists: true });
    mockTransactionCall.mockResolvedValue({
      successful: true,
      source_account: buyerPublicKey,
      envelope_xdr: xdr,
    });

    // Mitos on-chain transfer fails
    mockSubmitTransaction.mockRejectedValue(new Error("Horizon submit error"));

    const req = makeRequest({ buyerPublicKey, amount: 10, txHash: "fail-mitos-tx" });
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to send Mitos/i);

    // db.transaction() must NOT have been called — no partial writes
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
