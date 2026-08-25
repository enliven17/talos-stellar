/**
 * Idempotency tests for POST /api/talos/[id]/service
 *
 * Test matrix:
 *   positive  — new key creates the job and caches the response (201)
 *   positive  — equivalent retry (same key + same payload) returns original 201 from cache
 *   positive  — no header supplied → request proceeds without idempotency (backward compat)
 *   negative  — same key with a different payload → 409 Conflict
 *   negative  — key exists but response not yet cached (in-flight) → 409
 *   negative  — concurrent race: second INSERT hits unique constraint → 409
 *   concurrent — Promise.all with 3 identical requests: exactly one succeeds, two get 409
 *   existing  — paymentSig replay prevention still works independently of idempotency key
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST } from "../src/app/api/talos/[id]/service/route";
import { NextRequest } from "next/server";
import { tlsCommerceJobs } from "../src/db/schema";

// ─── Hoisted mock factories ───────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      insert: (...a: any[]) => mocks.mockTxInsert(...a),
      update: (...a: any[]) => mocks.mockTxUpdate(...a),
    });
  });

  return {
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTxInsert: vi.fn(),
    mockTxUpdate: vi.fn(),
    mockTransaction,
    mockFulfillInstant: vi.fn(),
    mockVerifyX402Payment: vi.fn(),
    mockSettleX402Payment: vi.fn(),
    mockResolveTalosFromRequest: vi.fn(),

    // Per-test result overrides
    _serviceResult: [] as any[],
    _talosResult: [] as any[],
    _idempotencyResult: [] as any[],
    _paymentSigResult: [] as any[],
    _idempotencyConflictResult: [] as any[],
    // Track how many times commerce-jobs has been selected
    _commerceJobsSelectCount: 0,
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

/**
 * Table-aware db.select() mock.
 *
 * Dispatches to the correct pre-configured result based on which table
 * was passed to .from().  Safe for Promise.all because dispatch is by
 * table identity, not call order.
 */
vi.mock("@/db", () => {
  const makeChain = () => {
    let resolvedTable: any = null;
    const chain: any = {
      from: vi.fn((table: any) => {
        resolvedTable = table;
        return chain;
      }),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (r: any) => any) => {
        const syms: symbol[] = resolvedTable
          ? Object.getOwnPropertySymbols(resolvedTable)
          : [];
        const nameSym = syms.find((s) => s.toString() === "Symbol(drizzle:Name)");
        const tableName: string = nameSym ? resolvedTable[nameSym] : "";

        if (tableName === "tls_commerce_services") {
          return Promise.resolve(cb(mocks._serviceResult));
        }
        if (tableName === "tls_talos") {
          return Promise.resolve(cb(mocks._talosResult));
        }
        if (tableName === "tls_commerce_jobs") {
          mocks._commerceJobsSelectCount += 1;
          // First select: idempotency check or paymentSig check (depending on test setup)
          // Second select: the other one
          const result =
            mocks._commerceJobsSelectCount === 1
              ? mocks._idempotencyResult
              : mocks._paymentSigResult;
          return Promise.resolve(cb(result));
        }
        return Promise.resolve(cb([]));
      }),
    };
    return chain;
  };

  return {
    db: {
      select: () => makeChain(),
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
      transaction: (cb: any) => mocks.mockTransaction(cb),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  resolveTalosFromRequest: (...a: any[]) => mocks.mockResolveTalosFromRequest(...a),
  verifyAgentApiKey: vi.fn(),
}));

vi.mock("@/lib/stellar-x402", () => ({
  verifyX402Payment: (...a: any[]) => mocks.mockVerifyX402Payment(...a),
  settleX402Payment: (...a: any[]) => mocks.mockSettleX402Payment(...a),
}));

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: (...a: any[]) => mocks.mockFulfillInstant(...a),
}));

vi.mock("@/lib/schemas", () => ({
  registerServiceSchema: {},
  submitBidSchema: { safeParse: () => ({ success: true, data: {} }) },
  parseBody: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/tracing", () => ({
  withTraceContext: (fn: any) => fn,
}));

// ─── Shared test data ─────────────────────────────────────────────────────────

const PROVIDER_ID = "provider-abc";
const BUYER_ID = "buyer-xyz";
const routeParams = Promise.resolve({ id: PROVIDER_ID });

const mockService = {
  id: "svc-1",
  talosId: PROVIDER_ID,
  serviceName: "research",
  description: "Research service",
  price: "5.00",
  currency: "USDC",
  fulfillmentMode: "async",
  stellarPublicKey: "GRECIPIENT",
  chains: ["stellar"],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockTalos = {
  agentWalletAddress: "GWALLET",
};

function makeRequest(opts: {
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  paymentToken?: string;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-payment": `x402 ${opts.paymentToken ?? "payment-token-default"}`,
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  return new NextRequest(`http://localhost/api/talos/${PROVIDER_ID}/service`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      payload: opts.payload ?? { query: "test" },
    }),
  });
}

/**
 * Configure what each table select should return for this test.
 * Resets the commerce-jobs call counter.
 *
 * @param hasIdempotencyKey  When false, the first commerce-jobs select is the
 *   paymentSig dupe check (not an idempotency lookup), so paymentSigResult
 *   is placed in the slot that count===1 reads.
 */
function setupSelects(opts: {
  service?: typeof mockService;
  talos?: typeof mockTalos;
  idempotencyResult?: any[];
  paymentSigResult?: any[];
  hasIdempotencyKey?: boolean;
}) {
  const {
    service,
    talos,
    idempotencyResult = [],
    paymentSigResult = [],
    hasIdempotencyKey = true,
  } = opts;

  mocks._serviceResult = service !== undefined ? [service] : [mockService];
  mocks._talosResult = talos !== undefined ? [talos] : [mockTalos];
  mocks._commerceJobsSelectCount = 0;

  if (hasIdempotencyKey) {
    // count=1 → idempotency check, count=2 → paymentSig dupe check
    mocks._idempotencyResult = idempotencyResult;
    mocks._paymentSigResult = paymentSigResult;
  } else {
    // count=1 → paymentSig dupe check (no idempotency select with no header)
    mocks._idempotencyResult = paymentSigResult;
    mocks._paymentSigResult = [];
  }
}

function resetInsertMock(jobId = "job-1") {
  mocks.mockInsert.mockImplementation((table: any) => {
    if (table === tlsCommerceJobs) {
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: jobId,
            status: "pending",
            serviceName: "research",
          }]),
        }),
      };
    }
    return { values: vi.fn().mockResolvedValue([]) };
  });
}

function resetUpdateMock() {
  mocks.mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });
}

function resetTxMocks(jobId = "job-1") {
  mocks.mockTxInsert.mockImplementation((table: any) => {
    if (table === tlsCommerceJobs) {
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: jobId,
            status: "pending",
            serviceName: "research",
          }]),
        }),
      };
    }
    return { values: vi.fn().mockResolvedValue([]) };
  });

  mocks.mockTxUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });
}

function setupAuth() {
  mocks.mockResolveTalosFromRequest.mockResolvedValue({
    ok: true,
    talos: { id: BUYER_ID },
  });
}

function setupPayment() {
  mocks.mockVerifyX402Payment.mockResolvedValue(true);
  mocks.mockSettleX402Payment.mockResolvedValue({ txHash: "tx-hash-settled" });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("service-purchase idempotency — positive (new key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("creates a job and returns 201 when a fresh Idempotency-Key is supplied", async () => {
    setupSelects({ idempotencyResult: [], paymentSigResult: [] });

    const req = makeRequest({ idempotencyKey: "key-fresh-1", paymentToken: "tok-fresh-1" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("pending");
    expect(body.jobId).toBeDefined();
    expect(res.headers.get("Idempotency-Key")).toBe("key-fresh-1");
    expect(res.headers.get("X-Idempotent-Replayed")).toBe("false");
  });

  it("creates a job normally with no Idempotency-Key header (backward compatibility)", async () => {
    setupSelects({ paymentSigResult: [], hasIdempotencyKey: false });

    const req = makeRequest({ paymentToken: "tok-no-key" });
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(201);
    // No idempotency headers when no key provided
    expect(res.headers.get("Idempotency-Key")).toBeNull();
    expect(res.headers.get("X-Idempotent-Replayed")).toBeNull();
  });
});

describe("service-purchase idempotency — positive (equivalent retry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("returns the original 201 response from cache on an equivalent retry", async () => {
    const cachedResponse = {
      jobId: "job-original",
      status: "completed",
      txHash: "tx-retry",
      result: { answer: "42" },
    };

    const existingJob = {
      id: "job-original",
      talosId: PROVIDER_ID,
      requesterTalosId: BUYER_ID,
      serviceName: "research",
      payload: { query: "test" },
      status: "completed",
      idempotencyKey: "key-retry-1",
      idempotencyResponse: cachedResponse,
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-retry-1",
      paymentToken: "tok-retry",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual(cachedResponse);
    expect(res.headers.get("X-Idempotent-Replayed")).toBe("true");
    // No payment verification or settlement should occur
    expect(mocks.mockVerifyX402Payment).not.toHaveBeenCalled();
    expect(mocks.mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mocks.mockInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when key exists but the response has not been cached yet (in-flight)", async () => {
    const existingJob = {
      id: "job-in-flight",
      talosId: PROVIDER_ID,
      requesterTalosId: BUYER_ID,
      serviceName: "research",
      payload: { query: "test" },
      status: "pending",
      idempotencyKey: "key-in-flight",
      idempotencyResponse: null,
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-in-flight",
      paymentToken: "tok-in-flight",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already being processed/i);
    expect(mocks.mockVerifyX402Payment).not.toHaveBeenCalled();
    expect(mocks.mockInsert).not.toHaveBeenCalled();
  });
});

describe("service-purchase idempotency — negative (conflict)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("returns 409 when the same key is reused with a different payload", async () => {
    const existingJob = {
      id: "job-conflict",
      talosId: PROVIDER_ID,
      requesterTalosId: BUYER_ID,
      serviceName: "research",
      payload: { query: "original query" },
      status: "pending",
      idempotencyKey: "key-conflict",
      idempotencyResponse: { jobId: "job-conflict", status: "pending" },
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-conflict",
      paymentToken: "tok-conflict",
      payload: { query: "different query" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/different payload/i);
    expect(mocks.mockVerifyX402Payment).not.toHaveBeenCalled();
    expect(mocks.mockInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when a concurrent INSERT hits the unique constraint (race condition)", async () => {
    setupSelects({ idempotencyResult: [], paymentSigResult: [] });

    const pgUniqueError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "tls_commerce_jobs_talos_requester_idempotencyKey_unique",
    });

    mocks.mockInsert.mockImplementation((table: any) => {
      if (table === tlsCommerceJobs) {
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(pgUniqueError),
          }),
        };
      }
      return { values: vi.fn().mockResolvedValue([]) };
    });

    mocks.mockTransaction.mockImplementation(async (cb: any) => {
      return cb({ insert: mocks.mockInsert, update: mocks.mockUpdate });
    });

    const req = makeRequest({ idempotencyKey: "key-race", paymentToken: "tok-race" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already being processed/i);
  });
});

describe("service-purchase idempotency — concurrent requests (Promise.all race)", () => {
  it("allows exactly one request through when N identical requests fire simultaneously", async () => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetUpdateMock();

    setupSelects({ idempotencyResult: [], paymentSigResult: [] });

    let insertCallCount = 0;

    mocks.mockInsert.mockImplementation((table: any) => {
      if (table === tlsCommerceJobs) {
        insertCallCount += 1;
        const n = insertCallCount;
        if (n === 1) {
          return {
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                id: "job-winner",
                status: "pending",
                serviceName: "research",
              }]),
            }),
          };
        }
        const err = Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint: "tls_commerce_jobs_talos_requester_idempotencyKey_unique",
        });
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(err),
          }),
        };
      }
      return { values: vi.fn().mockResolvedValue([]) };
    });

    mocks.mockTransaction.mockImplementation(async (cb: any) => {
      return cb({ insert: mocks.mockInsert, update: mocks.mockUpdate });
    });

    const makeReq = (n: number) =>
      makeRequest({
        idempotencyKey: "key-concurrent",
        paymentToken: `tok-concurrent-${n}`,
        payload: { query: "test" },
      });

    const [r1, r2, r3] = await Promise.all([
      POST(makeReq(1), { params: routeParams }),
      POST(makeReq(2), { params: routeParams }),
      POST(makeReq(3), { params: routeParams }),
    ]);

    const statuses = [r1.status, r2.status, r3.status];
    const successes = statuses.filter(s => s === 201);
    const conflicts = statuses.filter(s => s === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(2);

    const winner = [r1, r2, r3].find(r => r.status === 201)!;
    const body = await winner.json();
    expect(body.jobId).toBe("job-winner");
  });
});

describe("service-purchase idempotency — paymentSig replay prevention (unchanged)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("returns 409 when paymentSig was already used, even with no Idempotency-Key", async () => {
    setupSelects({ paymentSigResult: [{ id: "job-existing" }], hasIdempotencyKey: false });

    const req = makeRequest({ paymentToken: "tok-already-used" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already used/i);
    expect(mocks.mockInsert).not.toHaveBeenCalled();
  });
});

describe("service-purchase idempotency — key length validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("returns 400 when the Idempotency-Key exceeds 128 bytes", async () => {
    const longKey = "a".repeat(129);

    const req = makeRequest({ idempotencyKey: longKey });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/128 bytes/i);
  });
});

describe("service-purchase idempotency — different buyer with same key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAuth();
    setupPayment();
    resetInsertMock();
    resetUpdateMock();
    resetTxMocks();
  });

  it("allows a different buyer to use the same idempotency key on the same service", async () => {
    // The existing job belongs to buyer-abc, the new request is from buyer-xyz.
    // The idempotency check filters by requesterTalosId, so no conflict.
    setupSelects({ idempotencyResult: [], paymentSigResult: [] });

    const req = makeRequest({
      idempotencyKey: "shared-key",
      paymentToken: "tok-diff-buyer",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(201);
    expect(mocks.mockVerifyX402Payment).toHaveBeenCalled();
  });
});
