import { describe, it, expect, beforeEach } from "vitest";
import {
  transitionFromPending,
  transitionFromConfirming,
  computeTransition,
  buildFinalityEvidence,
} from "../src/lib/reconciler/state-machine";
import {
  recordEvidence,
  getEvidenceTrail,
  clearEvidenceTrail,
  getEvidenceCount,
  truncateTxHash,
  sanitizeEvidenceMetadata,
} from "../src/lib/reconciler/evidence";
import { extractObservationSource } from "../src/lib/reconciler/horizon";
import type {
  TxRecord,
  ReconcilerConfig,
  HorizonPollResult,
  FinalityEvidence,
} from "../src/lib/reconciler/types";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const BASE_CONFIG: ReconcilerConfig = {
  enabled: true,
  pollIntervalMs: 30_000,
  maxLedgerGap: 120,
  notFoundThreshold: 5,
  batchSize: 50,
  horizonUrl: "https://horizon-testnet.stellar.org",
  confirmationDepth: 1,
  concurrencyLimit: 5,
  maxEvidenceEntries: 10,
};

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: "tx_rec_test_001",
    txHash: "aabbccdd1122334455667788aabbccdd1122334455667788aabbccdd11223344",
    sourceType: "commerce_job",
    sourceId: "job_001",
    finalityStatus: "PENDING",
    ledgerSubmitted: 1000,
    lastLedgerChecked: null,
    confirmedLedger: null,
    pollCount: 0,
    lastError: null,
    repairApplied: false,
    expiresAt: new Date(Date.now() + 3_600_000), // 1 hr future
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CONFIRMED_POLL: HorizonPollResult = {
  outcome: "confirmed",
  ledger: 1005,
  successful: true,
  source: "horizon",
};

const FAILED_POLL: HorizonPollResult = {
  outcome: "failed",
  ledger: 1008,
  successful: false,
  detail: "tx_bad_seq",
  source: "horizon",
};

const NOT_FOUND_POLL: HorizonPollResult = {
  outcome: "not_found",
  source: "horizon",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Evidence Trail — State Machine Transitions", () => {
  beforeEach(() => {
    clearEvidenceTrail();
  });

  describe("transitionFromPending evidence generation", () => {
    it("records ledger, source='horizon', and reason for CONFIRMING transition", () => {
      const rec = makeRecord();
      const update = transitionFromPending(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("CONFIRMING");
      expect(update?.observationSource).toBe("horizon");
      expect(update?.transitionReason).toBe("Transaction confirmed on-chain in closed ledger");

      const ev = update?.evidence;
      expect(ev).toBeDefined();
      expect(ev?.txHash).toBe(rec.txHash);
      expect(ev?.ledger).toBe(1005);
      expect(ev?.observationSource).toBe("horizon");
      expect(ev?.transitionReason).toBe("Transaction confirmed on-chain in closed ledger");
      expect(ev?.fromStatus).toBe("PENDING");
      expect(ev?.toStatus).toBe("CONFIRMING");
      expect(ev?.decidedAt).toBeInstanceOf(Date);
    });

    it("records ledger, source='horizon', and result code reason for FAILED transition", () => {
      const rec = makeRecord();
      const update = transitionFromPending(rec, FAILED_POLL, 1010, BASE_CONFIG);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("FAILED");
      expect(update?.observationSource).toBe("horizon");
      expect(update?.transitionReason).toBe("tx_bad_seq");

      const ev = update?.evidence;
      expect(ev).toBeDefined();
      expect(ev?.ledger).toBe(1008);
      expect(ev?.observationSource).toBe("horizon");
      expect(ev?.transitionReason).toBe("tx_bad_seq");
      expect(ev?.fromStatus).toBe("PENDING");
      expect(ev?.toStatus).toBe("FAILED");
      expect(ev?.metadata?.resultCode).toBe("tx_bad_seq");
    });

    it("records ledger, source='horizon', and threshold reason for NOT_FOUND terminal transition", () => {
      const rec = makeRecord({ pollCount: 4 }); // threshold is 5; 4 + 1 = 5
      const update = transitionFromPending(rec, NOT_FOUND_POLL, 1020, BASE_CONFIG);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("NOT_FOUND");
      expect(update?.observationSource).toBe("horizon");
      expect(update?.transitionReason).toBe("NOT_FOUND after 5 polls");

      const ev = update?.evidence;
      expect(ev).toBeDefined();
      expect(ev?.ledger).toBe(1020);
      expect(ev?.observationSource).toBe("horizon");
      expect(ev?.fromStatus).toBe("PENDING");
      expect(ev?.toStatus).toBe("NOT_FOUND");
      expect(ev?.metadata?.pollCount).toBe(5);
    });

    it("does not generate evidence when NOT_FOUND poll stays below threshold", () => {
      const rec = makeRecord({ pollCount: 2 });
      const update = transitionFromPending(rec, NOT_FOUND_POLL, 1020, BASE_CONFIG);

      expect(update?.finalityStatus).toBeUndefined();
      expect(update?.evidence).toBeUndefined();
    });

    it("records ledger, source='wall_clock', and expiry reason for wall-clock expiry", () => {
      const now = new Date();
      const rec = makeRecord({ expiresAt: new Date(now.getTime() - 1000) });
      const update = transitionFromPending(rec, NOT_FOUND_POLL, 1025, BASE_CONFIG, now);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("EXPIRED");
      expect(update?.observationSource).toBe("wall_clock");
      expect(update?.transitionReason).toBe("Wall-clock expiry exceeded");

      const ev = update?.evidence;
      expect(ev).toBeDefined();
      expect(ev?.ledger).toBe(1025);
      expect(ev?.observationSource).toBe("wall_clock");
      expect(ev?.fromStatus).toBe("PENDING");
      expect(ev?.toStatus).toBe("EXPIRED");
    });

    it("records ledger, source='ledger_gap', and gap details for ledger gap expiry", () => {
      // ledgerSubmitted=1000, maxLedgerGap=120; current=1121 (> 1000+120)
      const rec = makeRecord({ ledgerSubmitted: 1000 });
      const update = transitionFromPending(rec, NOT_FOUND_POLL, 1121, BASE_CONFIG);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("EXPIRED");
      expect(update?.observationSource).toBe("ledger_gap");
      expect(update?.transitionReason).toContain("Ledger gap exceeded: current=1121");

      const ev = update?.evidence;
      expect(ev?.ledger).toBe(1121);
      expect(ev?.observationSource).toBe("ledger_gap");
      expect(ev?.fromStatus).toBe("PENDING");
      expect(ev?.toStatus).toBe("EXPIRED");
    });
  });

  describe("transitionFromConfirming evidence generation", () => {
    it("records ledger, source='horizon', and depth reason when CONFIRMED", () => {
      const rec = makeRecord({
        finalityStatus: "CONFIRMING",
        confirmedLedger: 1000,
      });
      // confirmationDepth=1; currentLedger=1001 >= 1000 + 1
      const update = transitionFromConfirming(rec, 1001, BASE_CONFIG);

      expect(update).not.toBeNull();
      expect(update?.finalityStatus).toBe("CONFIRMED");
      expect(update?.observationSource).toBe("horizon");
      expect(update?.transitionReason).toContain("Confirmation depth reached: current=1001, confirmed=1000, depth=1");

      const ev = update?.evidence;
      expect(ev).toBeDefined();
      expect(ev?.ledger).toBe(1001);
      expect(ev?.observationSource).toBe("horizon");
      expect(ev?.fromStatus).toBe("CONFIRMING");
      expect(ev?.toStatus).toBe("CONFIRMED");
    });

    it("records wall-clock expiry evidence from CONFIRMING", () => {
      const now = new Date();
      const rec = makeRecord({
        finalityStatus: "CONFIRMING",
        confirmedLedger: 1000,
        expiresAt: new Date(now.getTime() - 1000),
      });
      const update = transitionFromConfirming(rec, 1000, BASE_CONFIG, now);

      expect(update?.finalityStatus).toBe("EXPIRED");
      expect(update?.observationSource).toBe("wall_clock");
      expect(update?.transitionReason).toBe("Confirmation window expired (wall-clock)");
      expect(update?.evidence?.fromStatus).toBe("CONFIRMING");
      expect(update?.evidence?.toStatus).toBe("EXPIRED");
    });

    it("records ledger gap expiry evidence from CONFIRMING", () => {
      const rec = makeRecord({
        finalityStatus: "CONFIRMING",
        confirmedLedger: 1000,
        ledgerSubmitted: 1000,
      });
      const update = transitionFromConfirming(rec, 1125, BASE_CONFIG);

      expect(update?.finalityStatus).toBe("EXPIRED");
      expect(update?.observationSource).toBe("ledger_gap");
      expect(update?.transitionReason).toContain("Confirmation ledger gap exceeded");
      expect(update?.evidence?.ledger).toBe(1125);
    });

    it("does not generate evidence when depth is not yet met", () => {
      const rec = makeRecord({
        finalityStatus: "CONFIRMING",
        confirmedLedger: 1000,
      });
      // current=1000 < 1000 + 1 (depth=1)
      const update = transitionFromConfirming(rec, 1000, BASE_CONFIG);

      expect(update?.finalityStatus).toBeUndefined();
      expect(update?.evidence).toBeUndefined();
    });
  });

  describe("computeTransition unified evidence dispatch", () => {
    it("returns evidence across computeTransition dispatch", () => {
      const rec = makeRecord();
      const update = computeTransition(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);

      expect(update?.evidence).toBeDefined();
      expect(update?.evidence?.fromStatus).toBe("PENDING");
      expect(update?.evidence?.toStatus).toBe("CONFIRMING");
      expect(update?.evidence?.observationSource).toBe("horizon");
    });

    it("builds custom FinalityEvidence directly", () => {
      const rec = makeRecord();
      const customDate = new Date("2026-11-18T22:00:00Z");
      const ev: FinalityEvidence = buildFinalityEvidence({
        record: rec,
        fromStatus: "PENDING",
        toStatus: "CONFIRMED",
        ledger: 1050,
        observationSource: "reconciler",
        transitionReason: "Manual verification override",
        now: customDate,
      });

      expect(ev.txHash).toBe(rec.txHash);
      expect(ev.fromStatus).toBe("PENDING");
      expect(ev.toStatus).toBe("CONFIRMED");
      expect(ev.ledger).toBe(1050);
      expect(ev.observationSource).toBe("reconciler");
      expect(ev.transitionReason).toBe("Manual verification override");
      expect(ev.decidedAt).toEqual(customDate);
    });
  });
});

describe("Evidence Trail — Bounded Ring Buffer & Queries", () => {
  beforeEach(() => {
    clearEvidenceTrail();
  });

  it("stores evidence and enforces FIFO capacity bounding", () => {
    const maxEntries = 3;

    for (let i = 1; i <= 5; i++) {
      recordEvidence(
        {
          txHash: `hash_00${i}`,
          ledger: 1000 + i,
          observationSource: "horizon",
          transitionReason: `Decision ${i}`,
          fromStatus: "PENDING",
          toStatus: "CONFIRMED",
          decidedAt: new Date(`2026-11-18T10:0${i}:00Z`),
        },
        maxEntries,
      );
    }

    expect(getEvidenceCount()).toBe(3);
    const trail = getEvidenceTrail({}, 10);
    expect(trail).toHaveLength(3);

    // Oldest entries (1 and 2) evicted; 5, 4, 3 remain in descending chronological order
    expect(trail[0].txHash).toBe("hash_005");
    expect(trail[1].txHash).toBe("hash_004");
    expect(trail[2].txHash).toBe("hash_003");
  });

  it("filters evidence by txHash", () => {
    recordEvidence({
      txHash: "TARGET_HASH_ABC",
      ledger: 1001,
      observationSource: "horizon",
      transitionReason: "target 1",
      fromStatus: "PENDING",
      toStatus: "CONFIRMING",
      decidedAt: new Date(),
    });
    recordEvidence({
      txHash: "OTHER_HASH_XYZ",
      ledger: 1002,
      observationSource: "horizon",
      transitionReason: "other",
      fromStatus: "PENDING",
      toStatus: "CONFIRMING",
      decidedAt: new Date(),
    });

    const results = getEvidenceTrail({ txHash: "target_hash_abc" });
    expect(results).toHaveLength(1);
    expect(results[0].txHash).toBe("TARGET_HASH_ABC");
  });

  it("filters evidence by finality status", () => {
    recordEvidence({
      txHash: "hash_confirmed",
      ledger: 1001,
      observationSource: "horizon",
      transitionReason: "confirmed",
      fromStatus: "CONFIRMING",
      toStatus: "CONFIRMED",
      decidedAt: new Date(),
    });
    recordEvidence({
      txHash: "hash_failed",
      ledger: 1002,
      observationSource: "horizon",
      transitionReason: "failed",
      fromStatus: "PENDING",
      toStatus: "FAILED",
      decidedAt: new Date(),
    });

    const confirmedResults = getEvidenceTrail({ status: "CONFIRMED" });
    expect(confirmedResults).toHaveLength(1);
    expect(confirmedResults[0].txHash).toBe("hash_confirmed");

    const failedResults = getEvidenceTrail({ status: "FAILED" });
    expect(failedResults).toHaveLength(1);
    expect(failedResults[0].txHash).toBe("hash_failed");
  });

  it("filters evidence by observation source", () => {
    recordEvidence({
      txHash: "hash_h",
      ledger: 1001,
      observationSource: "horizon",
      transitionReason: "h",
      fromStatus: "PENDING",
      toStatus: "CONFIRMING",
      decidedAt: new Date(),
    });
    recordEvidence({
      txHash: "hash_w",
      ledger: 1002,
      observationSource: "wall_clock",
      transitionReason: "w",
      fromStatus: "PENDING",
      toStatus: "EXPIRED",
      decidedAt: new Date(),
    });

    const wallClockResults = getEvidenceTrail({ source: "wall_clock" });
    expect(wallClockResults).toHaveLength(1);
    expect(wallClockResults[0].txHash).toBe("hash_w");
  });

  it("bounds output strictly to requested limit and max limit", () => {
    for (let i = 0; i < 20; i++) {
      recordEvidence({
        txHash: `hash_${i}`,
        ledger: 1000 + i,
        observationSource: "horizon",
        transitionReason: `Reason ${i}`,
        fromStatus: "PENDING",
        toStatus: "CONFIRMING",
        decidedAt: new Date(Date.now() + i * 1000),
      });
    }

    const limited = getEvidenceTrail({ limit: 5 });
    expect(limited).toHaveLength(5);

    const capped = getEvidenceTrail({ limit: 100 }, 8);
    expect(capped).toHaveLength(8);
  });
});

describe("Evidence Trail — Privacy Guarantees", () => {
  it("sanitizes metadata and rejects secret keys and seed fields", () => {
    const rawMetadata = {
      pollCount: 3,
      threshold: 5,
      secret: "SUPER_SECRET_VALUE",
      seed: "SEED_PHRASE",
      privateKey: "PRIVATE_KEY_DATA",
      password: "SECRET_PASSWORD",
      token: "AUTH_TOKEN",
      key: "SIGNING_KEY",
      envelope_xdr: "AAAA...",
      payload: "{ \"user\": \"confidential\" }",
      stellarSecret: "SB7ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      safeDiagnostic: "tx_bad_seq",
    };

    const sanitized = sanitizeEvidenceMetadata(rawMetadata);
    expect(sanitized).toBeDefined();
    expect(sanitized?.pollCount).toBe(3);
    expect(sanitized?.threshold).toBe(5);
    expect(sanitized?.safeDiagnostic).toBe("tx_bad_seq");

    // All forbidden and secret-shaped keys must be completely removed
    expect(sanitized?.secret).toBeUndefined();
    expect(sanitized?.seed).toBeUndefined();
    expect(sanitized?.privateKey).toBeUndefined();
    expect(sanitized?.password).toBeUndefined();
    expect(sanitized?.token).toBeUndefined();
    expect(sanitized?.key).toBeUndefined();
    expect(sanitized?.envelope_xdr).toBeUndefined();
    expect(sanitized?.payload).toBeUndefined();
    expect(sanitized?.stellarSecret).toBeUndefined();
  });

  it("truncates hashes for display safely", () => {
    const fullHash = "68b49e7978648174780650123512341234123412341234123412341234123412";
    const truncated = truncateTxHash(fullHash);
    expect(truncated).toBe("68b49e79...34123412");
    expect(truncated.length).toBe(19);

    expect(truncateTxHash(null)).toBe("");
    expect(truncateTxHash("short")).toBe("short");
  });

  it("extracts observation source defaulting to horizon", () => {
    expect(extractObservationSource({ outcome: "confirmed", ledger: 1000, successful: true, source: "horizon_backup" })).toBe("horizon_backup");
    expect(extractObservationSource({ outcome: "not_found" })).toBe("horizon");
    expect(extractObservationSource(null)).toBe("horizon");
  });
});
