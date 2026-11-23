import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  _dbSelectResults: [] as any[],
  _dbSelectCallCount: 0,
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

vi.mock("@/db/schema", () => ({
  tlsStellarTxRecords: {
    txHash: "tx_hash",
    finalityStatus: "finality_status",
    ledgerSubmitted: "ledger_submitted",
    lastLedgerChecked: "last_ledger_checked",
    confirmedLedger: "confirmed_ledger",
    lastError: "last_error",
    updatedAt: "updated_at",
    createdAt: "created_at",
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { GET as evidenceRoute } from "../src/app/api/admin/reconciler/evidence/route";
import {
  recordEvidence,
  clearEvidenceTrail,
} from "../src/lib/reconciler/evidence";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "test-admin-key-evidence";
const TX_HASH_1 = "68b49e7978648174780650123512341234123412341234123412341234123412";
const TX_HASH_2 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function authedReq(url: string, method = "GET") {
  return new NextRequest(url, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
}

function unauthReq(url: string, method = "GET") {
  return new NextRequest(url, { method });
}

function wrongKeyReq(url: string, method = "GET") {
  return new NextRequest(url, {
    method,
    headers: { authorization: "Bearer wrong-admin-key" },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/admin/reconciler/evidence", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    clearEvidenceTrail();
    mocks._dbSelectResults = [];
    mocks._dbSelectCallCount = 0;
  });

  afterEach(() => {
    if (originalAdminKey !== undefined) {
      process.env.ADMIN_API_KEY = originalAdminKey;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  // ─── Authentication Tests ───────────────────────────────────────────────────

  describe("Authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await evidenceRoute(unauthReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/Missing Authorization header/i);
    });

    it("returns 403 when bearer token is invalid", async () => {
      const res = await evidenceRoute(wrongKeyReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid admin API key/i);
    });

    it("returns 500 when ADMIN_API_KEY is not configured in environment", async () => {
      delete process.env.ADMIN_API_KEY;
      const res = await evidenceRoute(authedReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/Admin API is not configured/i);
    });
  });

  // ─── Positive Queries & Bounded Evidence Trail ──────────────────────────────

  describe("Positive Queries", () => {
    it("returns empty evidence list with default limit when trail is empty", async () => {
      const res = await evidenceRoute(authedReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.evidence).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.limit).toBe(50);
    });

    it("returns recorded evidence entries with required schema fields", async () => {
      const now = new Date("2026-11-18T20:00:00.000Z");
      recordEvidence({
        txHash: TX_HASH_1,
        ledger: 1234567,
        observationSource: "horizon",
        transitionReason: "Transaction confirmed on-chain in closed ledger",
        fromStatus: "PENDING",
        toStatus: "CONFIRMING",
        decidedAt: now,
        metadata: { depth: 1 },
      });

      const res = await evidenceRoute(authedReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.evidence).toHaveLength(1);

      const entry = body.evidence[0];
      expect(entry.txHash).toBe(TX_HASH_1);
      expect(entry.txHashTruncated).toBe("68b49e79...34123412");
      expect(entry.ledger).toBe(1234567);
      expect(entry.observationSource).toBe("horizon");
      expect(entry.transitionReason).toBe("Transaction confirmed on-chain in closed ledger");
      expect(entry.fromStatus).toBe("PENDING");
      expect(entry.toStatus).toBe("CONFIRMING");
      expect(entry.decidedAt).toBe(now.toISOString());
      expect(entry.metadata).toEqual({ depth: 1 });
    });

    it("filters evidence by txHash", async () => {
      recordEvidence({
        txHash: TX_HASH_1,
        ledger: 1001,
        observationSource: "horizon",
        transitionReason: "confirmed 1",
        fromStatus: "PENDING",
        toStatus: "CONFIRMING",
        decidedAt: new Date("2026-11-18T20:01:00.000Z"),
      });
      recordEvidence({
        txHash: TX_HASH_2,
        ledger: 1002,
        observationSource: "horizon",
        transitionReason: "confirmed 2",
        fromStatus: "PENDING",
        toStatus: "CONFIRMING",
        decidedAt: new Date("2026-11-18T20:02:00.000Z"),
      });

      const res = await evidenceRoute(
        authedReq(`http://localhost/api/admin/reconciler/evidence?txHash=${TX_HASH_1}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.evidence[0].txHash).toBe(TX_HASH_1);
    });

    it("filters evidence by status", async () => {
      recordEvidence({
        txHash: TX_HASH_1,
        ledger: 1001,
        observationSource: "horizon",
        transitionReason: "confirmed",
        fromStatus: "CONFIRMING",
        toStatus: "CONFIRMED",
        decidedAt: new Date(),
      });
      recordEvidence({
        txHash: TX_HASH_2,
        ledger: 1002,
        observationSource: "horizon",
        transitionReason: "failed",
        fromStatus: "PENDING",
        toStatus: "FAILED",
        decidedAt: new Date(),
      });

      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?status=FAILED"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.evidence[0].toStatus).toBe("FAILED");
    });

    it("filters evidence by observation source", async () => {
      recordEvidence({
        txHash: TX_HASH_1,
        ledger: 1001,
        observationSource: "wall_clock",
        transitionReason: "expired",
        fromStatus: "PENDING",
        toStatus: "EXPIRED",
        decidedAt: new Date(),
      });
      recordEvidence({
        txHash: TX_HASH_2,
        ledger: 1002,
        observationSource: "horizon",
        transitionReason: "confirmed",
        fromStatus: "PENDING",
        toStatus: "CONFIRMING",
        decidedAt: new Date(),
      });

      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?source=wall_clock"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.evidence[0].observationSource).toBe("wall_clock");
    });

    it("respects custom limit within allowed bounds", async () => {
      for (let i = 0; i < 15; i++) {
        recordEvidence({
          txHash: `hash_${i}`,
          ledger: 1000 + i,
          observationSource: "horizon",
          transitionReason: `step ${i}`,
          fromStatus: "PENDING",
          toStatus: "CONFIRMING",
          decidedAt: new Date(Date.now() + i * 1000),
        });
      }

      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?limit=5"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.limit).toBe(5);
      expect(body.evidence).toHaveLength(5);
    });
  });

  // ─── Boundary & Failure Cases ───────────────────────────────────────────────

  describe("Boundary & Validation Cases", () => {
    it("returns 400 when limit is negative", async () => {
      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?limit=-5"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid limit parameter/i);
    });

    it("returns 400 when limit is zero", async () => {
      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?limit=0"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid limit parameter/i);
    });

    it("returns 400 when limit is non-integer", async () => {
      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?limit=abc"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid limit parameter/i);
    });

    it("caps limit at MAX_LIMIT (200) when limit exceeds ceiling", async () => {
      const res = await evidenceRoute(
        authedReq("http://localhost/api/admin/reconciler/evidence?limit=500"),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.limit).toBe(200);
    });
  });

  // ─── Privacy Safety Tests ───────────────────────────────────────────────────

  describe("Privacy & Secrets Safety", () => {
    it("never returns payment secrets, private keys, seeds, or confidential payloads", async () => {
      recordEvidence({
        txHash: TX_HASH_1,
        ledger: 1001,
        observationSource: "horizon",
        transitionReason: "tx_bad_seq",
        fromStatus: "PENDING",
        toStatus: "FAILED",
        decidedAt: new Date(),
        metadata: {
          resultCode: "tx_bad_seq",
          secret: "DO_NOT_LEAK",
          privateKey: "PRIVATE_KEY_BYTES",
          seed: "SEED_WORDS",
          token: "BEARER_SECRET",
          payload: "{ sensitive: true }",
        },
      });

      const res = await evidenceRoute(authedReq("http://localhost/api/admin/reconciler/evidence"));
      expect(res.status).toBe(200);
      const body = await res.json();
      const rawJson = JSON.stringify(body);

      // Must NOT contain sensitive keywords or values
      expect(rawJson).not.toContain("DO_NOT_LEAK");
      expect(rawJson).not.toContain("PRIVATE_KEY_BYTES");
      expect(rawJson).not.toContain("SEED_WORDS");
      expect(rawJson).not.toContain("BEARER_SECRET");
      expect(rawJson).not.toContain("envelope_xdr");
      expect(rawJson).not.toContain("result_xdr");

      // Verify safe metadata only
      expect(body.evidence[0].metadata).toEqual({ resultCode: "tx_bad_seq" });
    });
  });

  // ─── Database Fallback Lookup ───────────────────────────────────────────────

  describe("Database Fallback", () => {
    it("falls back to persisted record when queried txHash is not in memory", async () => {
      mocks._dbSelectResults = [
        [
          {
            txHash: TX_HASH_2,
            finalityStatus: "CONFIRMED",
            ledgerSubmitted: 1000,
            lastLedgerChecked: 1002,
            confirmedLedger: 1001,
            lastError: null,
            updatedAt: new Date("2026-11-18T19:00:00.000Z"),
            createdAt: new Date("2026-11-18T18:50:00.000Z"),
          },
        ],
      ];

      const res = await evidenceRoute(
        authedReq(`http://localhost/api/admin/reconciler/evidence?txHash=${TX_HASH_2}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);

      const entry = body.evidence[0];
      expect(entry.txHash).toBe(TX_HASH_2);
      expect(entry.ledger).toBe(1001);
      expect(entry.toStatus).toBe("CONFIRMED");
      expect(entry.observationSource).toBe("horizon");
      expect(entry.transitionReason).toBe("Transaction confirmed on-chain in closed ledger");
    });
  });
});
