/**
 * Unit tests: reconciler admin endpoints and per-job payment-status route
 *
 * Coverage matrix
 * ───────────────
 * GET /api/admin/reconciler
 *   ✓ returns stats snapshot when authorised
 *   ✓ returns 500 when ADMIN_API_KEY is not configured
 *   ✓ returns 401 with no Authorization header
 *   ✓ returns 403 with a wrong key
 *   ✓ response contains no secrets or sensitive fields
 *
 * POST /api/admin/reconciler/force
 *   ✓ runs one tick and returns summary (200) when Horizon is available
 *   ✓ returns 503 with partial summary when currentLedger is null (Horizon unreachable)
 *   ✓ returns 500 when runOneTick() throws unexpectedly
 *   ✓ returns 401 / 403 without valid auth
 *   ✓ response contains no secrets or sensitive fields
 *
 * GET /api/talos/:id/jobs/:jobId/payment-status
 *   positive
 *   ✓ returns full finality record when job and tx record both exist (PENDING)
 *   ✓ CONFIRMING status with lastLedgerChecked
 *   ✓ CONFIRMED status with confirmedLedger populated and repairApplied=true
 *   ✓ FAILED status with lastError diagnostic string
 *   ✓ EXPIRED status
 *   ✓ NOT_FOUND status
 *   ✓ registered:false when job exists but no tx record (legacy/instant)
 *   ✓ registered:false includes txHash from the job row
 *   negative
 *   ✓ 404 when job does not exist
 *   ✓ 404 when job belongs to a different talosId
 *   ✓ 500 on unexpected DB error — generic message, no detail leak
 *   boundary
 *   ✓ updatedAt serialised as ISO-8601 string
 *   ✓ confirmedLedger is null when status is PENDING
 *   ✓ lastError privacy — contains only safe diagnostic codes
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  runOneTick: vi.fn(),
  _dbSelectResults: [] as any[],
  _dbSelectCallCount: 0,
}));

vi.mock("@/lib/reconciler", () => ({
  getStats: (...args: any[]) => mocks.getStats(...args),
  runOneTick: (...args: any[]) => mocks.runOneTick(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => {
      const callIndex = mocks._dbSelectCallCount++;
      const row = mocks._dbSelectResults[callIndex] ?? [];
      const chain: any = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((cb: (rows: any[]) => any) => cb(row)),
      };
      return chain;
    }),
  },
}));

// ─── Route imports (after all vi.mock() calls) ────────────────────────────────

import { GET as statsRoute } from "../src/app/api/admin/reconciler/route";
import { POST as forceRoute } from "../src/app/api/admin/reconciler/force/route";
import { GET as paymentStatusRoute } from "../src/app/api/talos/[id]/jobs/[jobId]/payment-status/route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "test-admin-key-reconciler";
const TALOS_ID = "talos_recon_001";
const JOB_ID = "job_recon_001";
const TX_HASH = "deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12";

function authedReq(path: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
}

function unauthReq(path: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, { method });
}

function wrongKeyReq(path: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: "Bearer wrong-key" },
  });
}

function makeStats() {
  return {
    startedAt: new Date("2026-01-01T00:00:00Z"),
    lastTickAt: new Date("2026-01-01T00:01:00Z"),
    lastTickDurationMs: 120,
    tickCount: 42,
    totalConfirmed: 10,
    totalFailed: 2,
    totalExpired: 1,
    totalNotFound: 0,
    totalRepairsApplied: 12,
    totalErrors: 0,
    activeCount: 0,
    queueCount: 0,
  };
}

function makeSummary(currentLedger: number | null = 9999) {
  return {
    processed: 5,
    confirmed: 3,
    failed: 1,
    expired: 0,
    notFound: 0,
    repairsApplied: 3,
    errors: 0,
    currentLedger,
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    talosId: TALOS_ID,
    txHash: TX_HASH,
    status: "pending",
    ...overrides,
  };
}

function makeTxRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "txrec_001",
    txHash: TX_HASH,
    finalityStatus: "PENDING",
    confirmedLedger: null,
    lastLedgerChecked: 1050,
    pollCount: 3,
    lastError: null,
    repairApplied: false,
    updatedAt: new Date("2026-09-01T12:00:00Z"),
    ...overrides,
  };
}

// Helper: reset DB select sequence and enqueue results per call index
function setupDbSelects(...rows: Array<any[] | null>) {
  mocks._dbSelectCallCount = 0;
  mocks._dbSelectResults = rows.map((r) => r ?? []);
}

// Helper: call the payment-status route with a fresh select sequence
async function getStatus(
  jobRow: any,
  txRecordRow: any,
  talosId = TALOS_ID,
  jobId = JOB_ID,
) {
  setupDbSelects(jobRow ? [jobRow] : [], txRecordRow ? [txRecordRow] : []);
  return paymentStatusRoute(
    new NextRequest(`http://localhost/api/talos/${talosId}/jobs/${jobId}/payment-status`),
    { params: Promise.resolve({ id: talosId, jobId }) },
  );
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks._dbSelectCallCount = 0;
  mocks._dbSelectResults = [];
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  mocks.getStats.mockReturnValue(makeStats());
  mocks.runOneTick.mockResolvedValue(makeSummary());
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

// ─── GET /api/admin/reconciler ────────────────────────────────────────────────

describe("GET /api/admin/reconciler", () => {
  it("returns 200 with stats snapshot when authorised", async () => {
    const res = await statsRoute(authedReq("/api/admin/reconciler"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stats");
    expect(body.stats.tickCount).toBe(42);
    expect(body.stats.totalConfirmed).toBe(10);
  });

  it("returns 500 when ADMIN_API_KEY is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await statsRoute(unauthReq("/api/admin/reconciler"));
    expect(res.status).toBe(500);
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await statsRoute(unauthReq("/api/admin/reconciler"));
    expect(res.status).toBe(401);
  });

  it("returns 403 with a wrong key", async () => {
    const res = await statsRoute(wrongKeyReq("/api/admin/reconciler"));
    expect(res.status).toBe(403);
  });

  it("response body contains no sensitive fields", async () => {
    const res = await statsRoute(authedReq("/api/admin/reconciler"));
    const bodyStr = JSON.stringify(await res.json());
    expect(bodyStr).not.toMatch(/secret|seed|privateKey|wallet_key|xdr/i);
  });
});

// ─── POST /api/admin/reconciler/force ─────────────────────────────────────────

describe("POST /api/admin/reconciler/force", () => {
  it("returns 200 with tick summary when Horizon is available", async () => {
    const res = await forceRoute(authedReq("/api/admin/reconciler/force", "POST"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(body.summary.confirmed).toBe(3);
    expect(body.summary.currentLedger).toBe(9999);
  });

  it("returns 503 with partial summary when Horizon is unreachable (currentLedger=null)", async () => {
    mocks.runOneTick.mockResolvedValue(makeSummary(null));

    const res = await forceRoute(authedReq("/api/admin/reconciler/force", "POST"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.summary.currentLedger).toBeNull();
    expect(body.error).toMatch(/horizon unreachable/i);
  });

  it("returns 500 with a safe message when runOneTick() throws", async () => {
    mocks.runOneTick.mockRejectedValue(new Error("DB connection lost"));

    const res = await forceRoute(authedReq("/api/admin/reconciler/force", "POST"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Confirm no stack frame lines are echoed
    expect(body.error).not.toMatch(/at [A-Z]/);
  });

  it("returns 401 with no Authorization header and does not run a tick", async () => {
    const res = await forceRoute(unauthReq("/api/admin/reconciler/force", "POST"));
    expect(res.status).toBe(401);
    expect(mocks.runOneTick).not.toHaveBeenCalled();
  });

  it("returns 403 with a wrong key and does not run a tick", async () => {
    const res = await forceRoute(wrongKeyReq("/api/admin/reconciler/force", "POST"));
    expect(res.status).toBe(403);
    expect(mocks.runOneTick).not.toHaveBeenCalled();
  });

  it("response body contains no sensitive fields", async () => {
    const res = await forceRoute(authedReq("/api/admin/reconciler/force", "POST"));
    const bodyStr = JSON.stringify(await res.json());
    expect(bodyStr).not.toMatch(/secret|seed|privateKey|wallet_key|xdr/i);
  });
});

// ─── GET /api/talos/:id/jobs/:jobId/payment-status ────────────────────────────

describe("GET /api/talos/:id/jobs/:jobId/payment-status", () => {
  it("returns full finality record (PENDING) when both job and tx record exist", async () => {
    const res = await getStatus(makeJob(), makeTxRecord({ finalityStatus: "PENDING" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalityStatus).toBe("PENDING");
    expect(body.jobId).toBe(JOB_ID);
    expect(body.txHash).toBe(TX_HASH);
    expect(body.pollCount).toBe(3);
    expect(body.repairApplied).toBe(false);
  });

  it("returns CONFIRMING status with lastLedgerChecked populated", async () => {
    const res = await getStatus(
      makeJob(),
      makeTxRecord({ finalityStatus: "CONFIRMING", lastLedgerChecked: 1055 }),
    );
    const body = await res.json();
    expect(body.finalityStatus).toBe("CONFIRMING");
    expect(body.lastLedgerChecked).toBe(1055);
  });

  it("returns CONFIRMED status with confirmedLedger populated and repairApplied=true", async () => {
    const res = await getStatus(
      makeJob({ status: "pending" }),
      makeTxRecord({ finalityStatus: "CONFIRMED", confirmedLedger: 1060, repairApplied: true }),
    );
    const body = await res.json();
    expect(body.finalityStatus).toBe("CONFIRMED");
    expect(body.confirmedLedger).toBe(1060);
    expect(body.repairApplied).toBe(true);
  });

  it("returns FAILED status with lastError containing only a safe diagnostic code", async () => {
    const res = await getStatus(
      makeJob({ status: "payment_failed" }),
      makeTxRecord({ finalityStatus: "FAILED", lastError: "tx_bad_seq", repairApplied: true }),
    );
    const body = await res.json();
    expect(body.finalityStatus).toBe("FAILED");
    expect(body.lastError).toBe("tx_bad_seq");
    // Privacy: lastError must not contain private keys or secrets
    expect(body.lastError).not.toMatch(/secret|seed|S[A-Z2-7]{55}/);
  });

  it("returns EXPIRED status", async () => {
    const res = await getStatus(
      makeJob({ status: "payment_expired" }),
      makeTxRecord({
        finalityStatus: "EXPIRED",
        lastError: "Ledger gap exceeded: current=1200, submitted=1000, max=120",
        repairApplied: true,
      }),
    );
    const body = await res.json();
    expect(body.finalityStatus).toBe("EXPIRED");
    expect(body.lastError).toMatch(/Ledger gap exceeded/);
  });

  it("returns NOT_FOUND status", async () => {
    const res = await getStatus(
      makeJob({ status: "payment_not_found" }),
      makeTxRecord({
        finalityStatus: "NOT_FOUND",
        lastError: "NOT_FOUND after 10 polls",
        repairApplied: true,
      }),
    );
    const body = await res.json();
    expect(body.finalityStatus).toBe("NOT_FOUND");
  });

  it("returns registered:false when job exists but has no tx record (legacy/instant-fulfillment)", async () => {
    const res = await getStatus(makeJob(), null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalityStatus).toBeNull();
    expect(body.registered).toBe(false);
    expect(body.jobId).toBe(JOB_ID);
  });

  it("returns registered:false with the job's txHash when no tx record exists", async () => {
    const res = await getStatus(makeJob({ txHash: TX_HASH }), null);
    const body = await res.json();
    expect(body.txHash).toBe(TX_HASH);
    expect(body.registered).toBe(false);
  });

  it("returns 404 when job does not exist", async () => {
    const res = await getStatus(null, null);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Job not found");
  });

  it("returns 404 when job belongs to a different talosId (DB query returns empty)", async () => {
    // The WHERE clause filters by talosId; returning null simulates no match
    const res = await getStatus(null, null, "different_talos", JOB_ID);
    expect(res.status).toBe(404);
  });

  it("returns 500 with a generic message on unexpected DB error — no internal detail leaked", async () => {
    // Make the very first select() throw
    const { db } = await import("@/db");
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error("Simulated DB failure");
    });

    setupDbSelects();
    const res = await paymentStatusRoute(
      new NextRequest(`http://localhost/api/talos/${TALOS_ID}/jobs/${JOB_ID}/payment-status`),
      { params: Promise.resolve({ id: TALOS_ID, jobId: JOB_ID }) },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    // Verify the internal error message is not echoed
    expect(JSON.stringify(body)).not.toContain("Simulated DB failure");
  });

  it("updatedAt is returned as an ISO-8601 string", async () => {
    const res = await getStatus(
      makeJob(),
      makeTxRecord({ updatedAt: new Date("2026-09-01T12:00:00Z") }),
    );
    const body = await res.json();
    expect(body.updatedAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("confirmedLedger is null when finalityStatus is PENDING", async () => {
    const res = await getStatus(makeJob(), makeTxRecord({ finalityStatus: "PENDING", confirmedLedger: null }));
    const body = await res.json();
    expect(body.confirmedLedger).toBeNull();
  });
});
