/**
 * Unit tests for the finality state machine.
 *
 * Coverage matrix
 * ───────────────
 * transitionFromPending
 *   ✓ poll=confirmed  → CONFIRMING
 *   ✓ poll=failed     → FAILED
 *   ✓ poll=not_found below threshold → stay PENDING (bump count)
 *   ✓ poll=not_found at threshold    → NOT_FOUND
 *   ✓ poll=error (retryable)         → stay PENDING (bump count)
 *   ✓ poll=error (non-retryable)     → stay PENDING (bump count)
 *   ✓ wall-clock expiry              → EXPIRED
 *   ✓ ledger-gap expiry              → EXPIRED
 *   ✓ returns null for non-PENDING record
 *
 * transitionFromConfirming
 *   ✓ currentLedger < depth threshold → stay CONFIRMING (update checkpoint)
 *   ✓ currentLedger ≥ depth threshold → CONFIRMED
 *   ✓ wall-clock expiry              → EXPIRED
 *   ✓ ledger-gap expiry              → EXPIRED
 *   ✓ returns null for non-CONFIRMING record
 *
 * computeTransition
 *   ✓ terminal record → null
 *   ✓ PENDING + poll → delegates to transitionFromPending
 *   ✓ CONFIRMING + null poll → delegates to transitionFromConfirming
 *
 * needsRepair
 *   ✓ CONFIRMED + repairApplied=false → true
 *   ✓ CONFIRMED + repairApplied=true  → false
 *   ✓ FAILED    + repairApplied=false → true
 *   ✓ PENDING   + repairApplied=false → false
 *
 * validateTransition
 *   ✓ PENDING → CONFIRMING (legal)
 *   ✓ PENDING → NOT_FOUND  (legal)
 *   ✓ PENDING → PENDING    (no-op, legal)
 *   ✓ CONFIRMING → CONFIRMED (legal)
 *   ✓ CONFIRMED → PENDING    (illegal — terminal)
 *   ✓ PENDING → CONFIRMED    (illegal — skips CONFIRMING)
 *
 * isWallClockExpired / isLedgerExpired
 *   ✓ expired / not expired cases
 */

import { describe, it, expect } from "vitest";
import {
  transitionFromPending,
  transitionFromConfirming,
  computeTransition,
  needsRepair,
  validateTransition,
  isWallClockExpired,
  isLedgerExpired,
  isTerminal,
} from "../src/lib/reconciler/state-machine";
import type { TxRecord, ReconcilerConfig, HorizonPollResult } from "../src/lib/reconciler/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: ReconcilerConfig = {
  enabled: true,
  pollIntervalMs: 30_000,
  maxLedgerGap: 120,
  notFoundThreshold: 5,
  batchSize: 50,
  horizonUrl: "https://horizon-testnet.stellar.org",
  confirmationDepth: 2,
};

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    id: "rec_1",
    txHash: "abc123def456",
    sourceType: "commerce_job",
    sourceId: "job_1",
    finalityStatus: "PENDING",
    ledgerSubmitted: 1000,
    lastLedgerChecked: null,
    confirmedLedger: null,
    pollCount: 0,
    lastError: null,
    repairApplied: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CONFIRMED_POLL: HorizonPollResult = { outcome: "confirmed", ledger: 1010, successful: true };
const FAILED_POLL: HorizonPollResult = { outcome: "failed", ledger: 1010, successful: false, detail: "tx_bad_seq" };
const NOT_FOUND_POLL: HorizonPollResult = { outcome: "not_found" };
const ERROR_POLL_RETRYABLE: HorizonPollResult = { outcome: "error", message: "503 Service Unavailable", retryable: true };
const ERROR_POLL_PERMANENT: HorizonPollResult = { outcome: "error", message: "400 Bad Request", retryable: false };

// ─── isTerminal ───────────────────────────────────────────────────────────────

describe("isTerminal", () => {
  it("returns false for PENDING", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "PENDING" }))).toBe(false);
  });
  it("returns false for CONFIRMING", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "CONFIRMING" }))).toBe(false);
  });
  it("returns true for CONFIRMED", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "CONFIRMED" }))).toBe(true);
  });
  it("returns true for FAILED", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "FAILED" }))).toBe(true);
  });
  it("returns true for EXPIRED", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "EXPIRED" }))).toBe(true);
  });
  it("returns true for NOT_FOUND", () => {
    expect(isTerminal(makeRecord({ finalityStatus: "NOT_FOUND" }))).toBe(true);
  });
});

// ─── isWallClockExpired ───────────────────────────────────────────────────────

describe("isWallClockExpired", () => {
  it("returns false when expiresAt is null", () => {
    const rec = makeRecord({ expiresAt: null });
    expect(isWallClockExpired(rec)).toBe(false);
  });
  it("returns false when expiry is in the future", () => {
    const rec = makeRecord({ expiresAt: new Date(Date.now() + 10_000) });
    expect(isWallClockExpired(rec, new Date())).toBe(false);
  });
  it("returns true when expiry has passed", () => {
    const rec = makeRecord({ expiresAt: new Date(Date.now() - 1) });
    expect(isWallClockExpired(rec, new Date())).toBe(true);
  });
  it("returns true when expiry equals now", () => {
    const now = new Date();
    const rec = makeRecord({ expiresAt: now });
    expect(isWallClockExpired(rec, now)).toBe(true);
  });
});

// ─── isLedgerExpired ──────────────────────────────────────────────────────────

describe("isLedgerExpired", () => {
  it("returns false when ledgerSubmitted is null", () => {
    const rec = makeRecord({ ledgerSubmitted: null });
    expect(isLedgerExpired(rec, 2000, 120)).toBe(false);
  });
  it("returns false when within gap", () => {
    const rec = makeRecord({ ledgerSubmitted: 1000 });
    expect(isLedgerExpired(rec, 1100, 120)).toBe(false);
  });
  it("returns false at the exact boundary", () => {
    const rec = makeRecord({ ledgerSubmitted: 1000 });
    expect(isLedgerExpired(rec, 1120, 120)).toBe(false);
  });
  it("returns true when one past the boundary", () => {
    const rec = makeRecord({ ledgerSubmitted: 1000 });
    expect(isLedgerExpired(rec, 1121, 120)).toBe(true);
  });
});

// ─── transitionFromPending ────────────────────────────────────────────────────

describe("transitionFromPending", () => {
  it("transitions PENDING → CONFIRMING on confirmed poll", () => {
    const rec = makeRecord();
    const update = transitionFromPending(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("CONFIRMING");
    expect(update?.confirmedLedger).toBe(1010);
    expect(update?.lastError).toBeNull();
    expect(update?.pollCount).toBe(1);
  });

  it("transitions PENDING → FAILED on failed poll", () => {
    const rec = makeRecord();
    const update = transitionFromPending(rec, FAILED_POLL, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("FAILED");
    expect(update?.lastError).toBe("tx_bad_seq");
    expect(update?.pollCount).toBe(1);
  });

  it("stays PENDING and increments pollCount below notFoundThreshold", () => {
    const rec = makeRecord({ pollCount: 2 });
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1010, BASE_CONFIG);
    // threshold=5, count goes to 3 — not yet NOT_FOUND
    expect(update?.finalityStatus).toBeUndefined();
    expect(update?.pollCount).toBe(3);
  });

  it("transitions PENDING → NOT_FOUND at notFoundThreshold", () => {
    const rec = makeRecord({ pollCount: 4 }); // threshold=5, 4+1=5 => NOT_FOUND
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("NOT_FOUND");
    expect(update?.pollCount).toBe(5);
  });

  it("stays PENDING on retryable error, bumps pollCount", () => {
    const rec = makeRecord({ pollCount: 0 });
    const update = transitionFromPending(rec, ERROR_POLL_RETRYABLE, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBeUndefined();
    expect(update?.lastError).toBe("503 Service Unavailable");
    expect(update?.pollCount).toBe(1);
  });

  it("stays PENDING on non-retryable error, bumps pollCount", () => {
    const rec = makeRecord({ pollCount: 0 });
    const update = transitionFromPending(rec, ERROR_POLL_PERMANENT, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBeUndefined();
    expect(update?.pollCount).toBe(1);
  });

  it("transitions PENDING → EXPIRED when wall-clock expiry has passed", () => {
    const rec = makeRecord({ expiresAt: new Date(Date.now() - 1) });
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1010, BASE_CONFIG, new Date());
    expect(update?.finalityStatus).toBe("EXPIRED");
    expect(update?.lastError).toMatch(/expiry/i);
  });

  it("transitions PENDING → EXPIRED when ledger gap exceeded", () => {
    const rec = makeRecord({ ledgerSubmitted: 1000, expiresAt: new Date(Date.now() + 99_999) });
    // currentLedger = 1000 + 120 + 1 = 1121
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1121, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("EXPIRED");
    expect(update?.lastError).toMatch(/ledger gap/i);
  });

  it("returns null for a non-PENDING record", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMING" });
    const update = transitionFromPending(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);
    expect(update).toBeNull();
  });

  it("wall-clock expiry check fires before ledger-gap check", () => {
    // Both conditions true — wall-clock wins (higher priority)
    const rec = makeRecord({
      expiresAt: new Date(Date.now() - 1),
      ledgerSubmitted: 1000,
    });
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1200, BASE_CONFIG, new Date());
    expect(update?.finalityStatus).toBe("EXPIRED");
    expect(update?.lastError).toMatch(/wall-clock/i);
  });
});

// ─── transitionFromConfirming ─────────────────────────────────────────────────

describe("transitionFromConfirming", () => {
  it("stays CONFIRMING and updates checkpoint when depth not yet met", () => {
    // confirmedLedger=1010, depth=2, currentLedger=1011 → need 1010+2=1012
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1010 });
    const update = transitionFromConfirming(rec, 1011, BASE_CONFIG);
    expect(update?.finalityStatus).toBeUndefined();
    expect(update?.lastLedgerChecked).toBe(1011);
  });

  it("transitions CONFIRMING → CONFIRMED when depth is met", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1010 });
    // 1010 + 2 = 1012 — at 1012 should confirm
    const update = transitionFromConfirming(rec, 1012, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("CONFIRMED");
    expect(update?.lastError).toBeNull();
  });

  it("transitions CONFIRMING → CONFIRMED when currentLedger exceeds threshold", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1010 });
    const update = transitionFromConfirming(rec, 1050, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("CONFIRMED");
  });

  it("transitions CONFIRMING → EXPIRED on wall-clock expiry", () => {
    const rec = makeRecord({
      finalityStatus: "CONFIRMING",
      confirmedLedger: 1010,
      expiresAt: new Date(Date.now() - 1),
    });
    const update = transitionFromConfirming(rec, 1011, BASE_CONFIG, new Date());
    expect(update?.finalityStatus).toBe("EXPIRED");
  });

  it("transitions CONFIRMING → EXPIRED on ledger gap (counted from ledgerSubmitted)", () => {
    const rec = makeRecord({
      finalityStatus: "CONFIRMING",
      confirmedLedger: 1010,
      ledgerSubmitted: 900,
      expiresAt: new Date(Date.now() + 99_999),
    });
    // 900 + 120 + 1 = 1021 → expired
    const update = transitionFromConfirming(rec, 1021, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("EXPIRED");
  });

  it("returns null for non-CONFIRMING record", () => {
    const rec = makeRecord({ finalityStatus: "PENDING" });
    const update = transitionFromConfirming(rec, 1010, BASE_CONFIG);
    expect(update).toBeNull();
  });
});

// ─── computeTransition ───────────────────────────────────────────────────────

describe("computeTransition", () => {
  it("returns null for a terminal CONFIRMED record", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMED" });
    const update = computeTransition(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);
    expect(update).toBeNull();
  });

  it("returns null for a terminal FAILED record", () => {
    const rec = makeRecord({ finalityStatus: "FAILED" });
    const update = computeTransition(rec, null, 1010, BASE_CONFIG);
    expect(update).toBeNull();
  });

  it("returns null for PENDING when no poll result is provided", () => {
    const rec = makeRecord({ finalityStatus: "PENDING" });
    const update = computeTransition(rec, null, 1010, BASE_CONFIG);
    expect(update).toBeNull();
  });

  it("delegates to transitionFromPending for PENDING records", () => {
    const rec = makeRecord({ finalityStatus: "PENDING" });
    const update = computeTransition(rec, CONFIRMED_POLL, 1010, BASE_CONFIG);
    expect(update?.finalityStatus).toBe("CONFIRMING");
  });

  it("delegates to transitionFromConfirming for CONFIRMING records (ignores pollResult)", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1000 });
    const update = computeTransition(rec, CONFIRMED_POLL, 1002, BASE_CONFIG);
    // confirmationDepth=2, 1000+2=1002 → CONFIRMED
    expect(update?.finalityStatus).toBe("CONFIRMED");
  });
});

// ─── needsRepair ─────────────────────────────────────────────────────────────

describe("needsRepair", () => {
  it("returns true for CONFIRMED + repairApplied=false", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "CONFIRMED", repairApplied: false }))).toBe(true);
  });

  it("returns false for CONFIRMED + repairApplied=true", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "CONFIRMED", repairApplied: true }))).toBe(false);
  });

  it("returns true for FAILED + repairApplied=false", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "FAILED", repairApplied: false }))).toBe(true);
  });

  it("returns true for EXPIRED + repairApplied=false", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "EXPIRED", repairApplied: false }))).toBe(true);
  });

  it("returns true for NOT_FOUND + repairApplied=false", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "NOT_FOUND", repairApplied: false }))).toBe(true);
  });

  it("returns false for PENDING (not terminal)", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "PENDING", repairApplied: false }))).toBe(false);
  });

  it("returns false for CONFIRMING (not terminal)", () => {
    expect(needsRepair(makeRecord({ finalityStatus: "CONFIRMING", repairApplied: false }))).toBe(false);
  });
});

// ─── validateTransition ──────────────────────────────────────────────────────

describe("validateTransition", () => {
  // Legal transitions
  it("accepts PENDING → CONFIRMING", () => {
    expect(validateTransition("PENDING", "CONFIRMING")).toBeNull();
  });
  it("accepts PENDING → FAILED", () => {
    expect(validateTransition("PENDING", "FAILED")).toBeNull();
  });
  it("accepts PENDING → EXPIRED", () => {
    expect(validateTransition("PENDING", "EXPIRED")).toBeNull();
  });
  it("accepts PENDING → NOT_FOUND", () => {
    expect(validateTransition("PENDING", "NOT_FOUND")).toBeNull();
  });
  it("accepts CONFIRMING → CONFIRMED", () => {
    expect(validateTransition("CONFIRMING", "CONFIRMED")).toBeNull();
  });
  it("accepts CONFIRMING → FAILED", () => {
    expect(validateTransition("CONFIRMING", "FAILED")).toBeNull();
  });
  it("accepts CONFIRMING → EXPIRED", () => {
    expect(validateTransition("CONFIRMING", "EXPIRED")).toBeNull();
  });
  it("accepts no-op same-state transitions", () => {
    expect(validateTransition("PENDING", "PENDING")).toBeNull();
    expect(validateTransition("CONFIRMED", "CONFIRMED")).toBeNull();
  });

  // Illegal: leaving terminal states
  it("rejects CONFIRMED → PENDING (terminal)", () => {
    expect(validateTransition("CONFIRMED", "PENDING")).not.toBeNull();
  });
  it("rejects FAILED → CONFIRMING (terminal)", () => {
    expect(validateTransition("FAILED", "CONFIRMING")).not.toBeNull();
  });
  it("rejects EXPIRED → PENDING (terminal)", () => {
    expect(validateTransition("EXPIRED", "PENDING")).not.toBeNull();
  });
  it("rejects NOT_FOUND → CONFIRMED (terminal)", () => {
    expect(validateTransition("NOT_FOUND", "CONFIRMED")).not.toBeNull();
  });

  // Illegal: skipping states
  it("rejects PENDING → CONFIRMED (must go through CONFIRMING)", () => {
    expect(validateTransition("PENDING", "CONFIRMED")).not.toBeNull();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("State machine edge cases", () => {
  it("handles confirmationDepth=1 (immediate confirmation)", () => {
    const config = { ...BASE_CONFIG, confirmationDepth: 1 };
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1010 });
    const update = transitionFromConfirming(rec, 1011, config);
    expect(update?.finalityStatus).toBe("CONFIRMED");
  });

  it("handles confirmationDepth=0 (instant confirmation)", () => {
    const config = { ...BASE_CONFIG, confirmationDepth: 0 };
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: 1010 });
    const update = transitionFromConfirming(rec, 1010, config);
    expect(update?.finalityStatus).toBe("CONFIRMED");
  });

  it("handles a record with null confirmedLedger in CONFIRMING (stays CONFIRMING)", () => {
    const rec = makeRecord({ finalityStatus: "CONFIRMING", confirmedLedger: null });
    const update = transitionFromConfirming(rec, 9999, BASE_CONFIG);
    // confirmedLedger is null → can't compute depth → just update checkpoint
    expect(update?.finalityStatus).toBeUndefined();
    expect(update?.lastLedgerChecked).toBe(9999);
  });

  it("duplicate poll result on already-expiring record returns EXPIRED, not CONFIRMING", () => {
    const rec = makeRecord({
      expiresAt: new Date(Date.now() - 1),
      finalityStatus: "PENDING",
      pollCount: 0,
    });
    const update = computeTransition(rec, CONFIRMED_POLL, 1010, BASE_CONFIG, new Date());
    expect(update?.finalityStatus).toBe("EXPIRED");
  });

  it("notFoundThreshold=1 immediately goes to NOT_FOUND on first miss", () => {
    const config = { ...BASE_CONFIG, notFoundThreshold: 1 };
    const rec = makeRecord({ pollCount: 0 });
    const update = transitionFromPending(rec, NOT_FOUND_POLL, 1010, config);
    expect(update?.finalityStatus).toBe("NOT_FOUND");
  });
});
