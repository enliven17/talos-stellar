/**
 * Idempotency tests for POST /api/talos/[id]/jobs
 *
 * Test matrix:
 *   positive  — new key creates the job and caches the response (201)
 *   positive  — equivalent retry (same key + same payload) returns original 201 from cache
 *   positive  — no header supplied → request proceeds without idempotency (backward compat)
 *   negative  — same key with a different payload → 409 Conflict
 *   negative  — same key with a different serviceName → 409 Conflict
 *   negative  — key exists but response not yet cached (in-flight) → 409
 *   negative  — concurrent race: second INSERT hits unique constraint → 409
 *   concurrent — Promise.all with 3 identical requests: exactly one succeeds, two get 409
 *   existing  — txHash replay prevention still works independently of idempotency key
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { POST } from "../src/app/api/talos/[id]/jobs/route";
import { NextRequest } from "next/server";
import { tlsCommerceJobs } from "../src/db/schema";

// ─── Hoisted mock factories ───────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const mockTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    return cb({
      insert: (...a: any[]) => mocks.mockInsert(...a),
      update: (...a: any[]) => mocks.mockUpdate(...a),
    });
  });

  return {
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockTransaction,
    mockFulfillInstant: vi.fn(),

    // Per-test result overrides, keyed by what should be returned for each
    // table query.  Using table-aware dispatch avoids ordering issues with
    // Promise.all consuming mockReturnValueOnce slots in undefined order.
    _serviceResult: [] as any[],
    _talosResult: [] as any[],
    _idempotencyResult: [] as any[],
    _dupeResult: [] as any[],
    // Track how many times commerce-jobs has been selected (idempotency vs dupe)
    _commerceJobsSelectCount: 0,
  };
});

// ─── Module mocks ─────────────────────────────────────────────────────────────

/**
 * Table-aware db.select() mock.
 *
 * Returns a chainable whose .from(table) call stores the table reference, and
 * whose .then(cb) dispatches to the correct pre-configured result based on
 * which table was passed to .from().
 *
 * This is safe for Promise.all because the dispatch is by table identity, not
 * by call order.  The two tlsCommerceJobs selects (idempotency check and txHash
 * dupe check) are distinguished by a per-test call counter that is reset in
 * beforeEach.
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
        // Identify the table by reading the Drizzle internal name symbol.
        // getTableName() is not available inside vi.mock (no imports), so we
        // read the symbol directly — it is always Symbol(drizzle:Name).
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
          const result =
            mocks._commerceJobsSelectCount === 1
              ? mocks._idempotencyResult
              : mocks._dupeResult;
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

vi.mock("@/lib/fulfillment", () => ({
  fulfillInstant: (...a: any[]) => mocks.mockFulfillInstant(...a),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: { Server: class { submitTransaction = vi.fn(); } },
  TransactionBuilder: { fromXDR: vi.fn() },
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  Asset: class { constructor(public code: string, public issuer: string) {} },
}));

// ─── Shared test data ─────────────────────────────────────────────────────────

const AGENT_ID = "agent-abc";
const routeParams = Promise.resolve({ id: AGENT_ID });

const mockService = {
  id: "svc-1",
  talosId: AGENT_ID,
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
  id: AGENT_ID,
  agentOnline: true,
  name: "Test Agent",
  agentWalletAddress: "GWALLET",
};

function makeRequest(opts: {
  payload?: Record<string, unknown>;
  txHash?: string;
  idempotencyKey?: string | null;
}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  return new NextRequest(`http://localhost/api/talos/${AGENT_ID}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      buyerPublicKey: "GBUYER",
      txHash: opts.txHash ?? "tx-default",
      payload: opts.payload ?? { query: "test" },
    }),
  });
}

/**
 * Configure what each table select should return for this test.
 * Also resets the commerce-jobs call counter.
 *
 * @param hasIdempotencyKey  When false (no header), the first commerce-jobs
 *   select is the txHash dupe check (not an idempotency lookup), so dupeResult
 *   is placed in the slot that count===1 reads.
 */
function setupSelects(opts: {
  service?: typeof mockService;
  talos?: typeof mockTalos;
  idempotencyResult?: any[];
  dupeResult?: any[];
  hasIdempotencyKey?: boolean;
}) {
  const {
    service,
    talos,
    idempotencyResult = [],
    dupeResult = [],
    hasIdempotencyKey = true,
  } = opts;

  mocks._serviceResult = service !== undefined ? [service] : [mockService];
  mocks._talosResult = talos !== undefined ? [talos] : [mockTalos];
  mocks._commerceJobsSelectCount = 0;

  if (hasIdempotencyKey) {
    // count=1 → idempotency check, count=2 → txHash dupe check
    mocks._idempotencyResult = idempotencyResult;
    mocks._dupeResult = dupeResult;
  } else {
    // count=1 → txHash dupe check (no idempotency select with no header)
    mocks._idempotencyResult = dupeResult;
    mocks._dupeResult = [];
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("commerce-jobs idempotency — positive (new key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
  });

  it("creates a job and returns 201 when a fresh Idempotency-Key is supplied", async () => {
    setupSelects({ idempotencyResult: [], dupeResult: [] });

    const req = makeRequest({ idempotencyKey: "key-fresh-1", txHash: "tx-fresh-1" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.status).toBe("pending");
    expect(body.jobId).toBeDefined();
    expect(mocks.mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("creates a job normally with no Idempotency-Key header (backward compatibility)", async () => {
    // No header → no idempotency check fired; dupeResult is the only commerce-jobs select
    setupSelects({ dupeResult: [], hasIdempotencyKey: false });

    const req = makeRequest({ txHash: "tx-no-key" });
    const res = await POST(req, { params: routeParams });

    expect(res.status).toBe(201);
    expect(mocks.mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("commerce-jobs idempotency — positive (equivalent retry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
  });

  it("returns the original 201 response from cache on an equivalent retry", async () => {
    const cachedResponse = {
      jobId: "job-original",
      status: "pending",
      serviceName: "research",
      amount: 5,
      txHash: "tx-retry",
      message: "Job queued. The agent will process your request and you can poll for results.",
    };

    const existingJob = {
      id: "job-original",
      talosId: AGENT_ID,
      serviceName: "research",
      payload: { query: "test" },
      status: "pending",
      idempotencyKey: "key-retry-1",
      idempotencyResponse: cachedResponse,
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-retry-1",
      txHash: "tx-retry",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual(cachedResponse);
    expect(mocks.mockInsert).not.toHaveBeenCalled();
    expect(mocks.mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when key exists but the response has not been cached yet (in-flight)", async () => {
    const existingJob = {
      id: "job-in-flight",
      talosId: AGENT_ID,
      serviceName: "research",
      payload: { query: "test" },
      status: "pending",
      idempotencyKey: "key-in-flight",
      idempotencyResponse: null,
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-in-flight",
      txHash: "tx-in-flight",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already being processed/i);
    expect(mocks.mockInsert).not.toHaveBeenCalled();
    expect(mocks.mockTransaction).not.toHaveBeenCalled();
  });
});

describe("commerce-jobs idempotency — negative (conflict)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
  });

  it("returns 409 when the same key is reused with a different payload", async () => {
    const existingJob = {
      id: "job-conflict",
      talosId: AGENT_ID,
      serviceName: "research",
      payload: { query: "original query" },
      status: "pending",
      idempotencyKey: "key-conflict",
      idempotencyResponse: { jobId: "job-conflict", status: "pending" },
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-conflict",
      txHash: "tx-conflict",
      payload: { query: "different query" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/different payload/i);
    expect(mocks.mockInsert).not.toHaveBeenCalled();
    expect(mocks.mockTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when the same key is reused for a different serviceName", async () => {
    // Existing job was created for "lead-gen"; current service resolves as "research"
    const existingJob = {
      id: "job-svc-conflict",
      talosId: AGENT_ID,
      serviceName: "lead-gen",
      payload: { query: "test" },
      status: "pending",
      idempotencyKey: "key-svc-conflict",
      idempotencyResponse: { jobId: "job-svc-conflict", status: "pending" },
    };

    setupSelects({ idempotencyResult: [existingJob] });

    const req = makeRequest({
      idempotencyKey: "key-svc-conflict",
      txHash: "tx-svc-conflict",
      payload: { query: "test" },
    });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/different payload/i);
    expect(mocks.mockInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when a concurrent INSERT hits the unique constraint (race condition)", async () => {
    setupSelects({ idempotencyResult: [], dupeResult: [] });

    const pgUniqueError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      constraint: "tls_commerce_jobs_talosId_idempotencyKey_unique",
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

    const req = makeRequest({ idempotencyKey: "key-race", txHash: "tx-race" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already being processed/i);
  });
});

describe("commerce-jobs idempotency — concurrent requests (Promise.all race)", () => {
  it("allows exactly one request through when N identical requests fire simultaneously", async () => {
    vi.clearAllMocks();
    resetUpdateMock();

    // All 3 concurrent requests see the same service/talos/empty idempotency/empty dupe.
    // Because the select mock is table-aware (not order-dependent), concurrent
    // Promise.all calls within each request return the correct result regardless of order.
    setupSelects({ idempotencyResult: [], dupeResult: [] });

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
          constraint: "tls_commerce_jobs_talosId_idempotencyKey_unique",
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
        txHash: `tx-concurrent-${n}`,
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
    expect(body.status).toBe("pending");

    // The winning INSERT was committed exactly once; the other two threw 23505
    // and were caught — so mockTransaction is entered 3 times but only 1 succeeds.
    expect(insertCallCount).toBe(3);
    expect(mocks.mockTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("commerce-jobs idempotency — txHash replay prevention (unchanged behaviour)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetInsertMock();
    resetUpdateMock();
  });

  it("returns 409 when txHash was already used, even with no Idempotency-Key", async () => {
    // No header → only 1 commerce-jobs select (dupe check), not 2
    setupSelects({ dupeResult: [{ id: "job-existing" }], hasIdempotencyKey: false });

    const req = makeRequest({ txHash: "tx-already-used" });
    const res = await POST(req, { params: routeParams });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already used/i);
    expect(mocks.mockTransaction).not.toHaveBeenCalled();
  });
});
