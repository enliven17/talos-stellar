/**
 * Finality state machine for Stellar transactions.
 *
 * This module contains ONLY pure transition logic — no I/O, no DB writes,
 * no Horizon calls.  Every function is deterministic and unit-testable in
 * isolation.  The scheduler drives the machine by calling these helpers and
 * then persisting the resulting TxRecordUpdate objects.
 *
 * Allowed transitions
 * ───────────────────
 *   PENDING    → CONFIRMING  (Horizon 200 + successful=true, within ledger gap)
 *   PENDING    → FAILED      (Horizon 200 + successful=false)
 *   PENDING    → NOT_FOUND   (repeated 404s ≥ notFoundThreshold)
 *   PENDING    → EXPIRED     (poll ledger > ledger_submitted + maxLedgerGap, or expiresAt passed)
 *   CONFIRMING → CONFIRMED   (currentLedger ≥ confirmedLedger + confirmationDepth)
 *   CONFIRMING → FAILED      (should not happen after first-seen, but defensively allowed)
 *   CONFIRMING → EXPIRED     (confirmation window elapsed without reaching depth)
 *   Any active → EXPIRED     (wall-clock expiresAt exceeded)
 */

import type {
  FinalityStatus,
  TxRecord,
  TxRecordUpdate,
  HorizonPollResult,
  ReconcilerConfig,
} from "./types";
import { TERMINAL_STATES } from "./types";

// ─── Guard ───────────────────────────────────────────────────────────────────

/** Returns true if the record is already in a terminal state. */
export function isTerminal(record: TxRecord): boolean {
  return TERMINAL_STATES.has(record.finalityStatus);
}

// ─── Expiry check ─────────────────────────────────────────────────────────────

/**
 * Returns true if the record should transition to EXPIRED based on wall-clock
 * time (expiresAt column) regardless of ledger position.
 */
export function isWallClockExpired(record: TxRecord, now: Date = new Date()): boolean {
  if (!record.expiresAt) return false;
  return now >= record.expiresAt;
}

/**
 * Returns true if the record should transition to EXPIRED based on ledger gap.
 * Only applicable when ledgerSubmitted is known.
 */
export function isLedgerExpired(
  record: TxRecord,
  currentLedger: number,
  maxLedgerGap: number,
): boolean {
  if (!record.ledgerSubmitted) return false;
  return currentLedger > record.ledgerSubmitted + maxLedgerGap;
}

// ─── Transition functions ─────────────────────────────────────────────────────

/**
 * Compute the next state update for a PENDING record given the latest poll
 * result and current ledger.  Returns null if the record should not change.
 */
export function transitionFromPending(
  record: TxRecord,
  pollResult: HorizonPollResult,
  currentLedger: number,
  config: ReconcilerConfig,
  now: Date = new Date(),
): TxRecordUpdate | null {
  if (record.finalityStatus !== "PENDING") return null;

  // Wall-clock expiry takes precedence over all other checks
  if (isWallClockExpired(record, now)) {
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: "Wall-clock expiry exceeded",
      pollCount: record.pollCount + 1,
      updatedAt: now,
    };
  }

  // Ledger gap expiry
  if (isLedgerExpired(record, currentLedger, config.maxLedgerGap)) {
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: `Ledger gap exceeded: current=${currentLedger}, submitted=${record.ledgerSubmitted}, max=${config.maxLedgerGap}`,
      pollCount: record.pollCount + 1,
      updatedAt: now,
    };
  }

  switch (pollResult.outcome) {
    case "confirmed":
      return {
        finalityStatus: "CONFIRMING",
        lastLedgerChecked: currentLedger,
        confirmedLedger: pollResult.ledger,
        lastError: null,
        pollCount: record.pollCount + 1,
        updatedAt: now,
      };

    case "failed":
      return {
        finalityStatus: "FAILED",
        lastLedgerChecked: currentLedger,
        confirmedLedger: pollResult.ledger,
        lastError: pollResult.detail ?? "Transaction unsuccessful on-chain",
        pollCount: record.pollCount + 1,
        updatedAt: now,
      };

    case "not_found": {
      const newPollCount = record.pollCount + 1;
      if (newPollCount >= config.notFoundThreshold) {
        return {
          finalityStatus: "NOT_FOUND",
          lastLedgerChecked: currentLedger,
          lastError: `NOT_FOUND after ${newPollCount} polls`,
          pollCount: newPollCount,
          updatedAt: now,
        };
      }
      return {
        lastLedgerChecked: currentLedger,
        pollCount: newPollCount,
        updatedAt: now,
      };
    }

    case "error":
      // Transient Horizon error — bump poll count but stay in PENDING
      return {
        lastLedgerChecked: currentLedger,
        lastError: pollResult.message,
        pollCount: record.pollCount + 1,
        updatedAt: now,
      };
  }
}

/**
 * Compute the next state update for a CONFIRMING record.
 *
 * Stellar has single-round finality: once a transaction is included in a
 * closed ledger it cannot be rolled back.  We still apply a configurable
 * `confirmationDepth` so operators can dial in extra conservatism.
 */
export function transitionFromConfirming(
  record: TxRecord,
  currentLedger: number,
  config: ReconcilerConfig,
  now: Date = new Date(),
): TxRecordUpdate | null {
  if (record.finalityStatus !== "CONFIRMING") return null;

  // Wall-clock expiry
  if (isWallClockExpired(record, now)) {
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: "Confirmation window expired (wall-clock)",
      updatedAt: now,
    };
  }

  // Ledger gap for confirming: count from the ledger it was first seen in
  if (
    record.ledgerSubmitted &&
    isLedgerExpired(record, currentLedger, config.maxLedgerGap)
  ) {
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: `Confirmation ledger gap exceeded: current=${currentLedger}`,
      updatedAt: now,
    };
  }

  // Check depth
  if (
    record.confirmedLedger !== null &&
    record.confirmedLedger !== undefined &&
    currentLedger >= record.confirmedLedger + config.confirmationDepth
  ) {
    return {
      finalityStatus: "CONFIRMED",
      lastLedgerChecked: currentLedger,
      lastError: null,
      updatedAt: now,
    };
  }

  // Not yet deep enough — just update the checkpoint
  return {
    lastLedgerChecked: currentLedger,
    updatedAt: now,
  };
}

/**
 * Unified transition entry-point.  Dispatches to the correct transition
 * function based on the record's current state, then returns the update
 * (or null if no change is warranted).
 */
export function computeTransition(
  record: TxRecord,
  pollResult: HorizonPollResult | null,
  currentLedger: number,
  config: ReconcilerConfig,
  now: Date = new Date(),
): TxRecordUpdate | null {
  if (isTerminal(record)) return null;

  switch (record.finalityStatus) {
    case "PENDING":
      if (!pollResult) return null;
      return transitionFromPending(record, pollResult, currentLedger, config, now);

    case "CONFIRMING":
      return transitionFromConfirming(record, currentLedger, config, now);

    default:
      return null;
  }
}

/**
 * Returns true when a CONFIRMED or FAILED/EXPIRED/NOT_FOUND record needs its
 * downstream repair applied (repair_applied=false and in terminal state).
 */
export function needsRepair(record: TxRecord): boolean {
  return !record.repairApplied && TERMINAL_STATES.has(record.finalityStatus);
}

/**
 * Validate that a proposed next state is a legal transition from the current
 * state.  Returns an error string if invalid, null if valid.
 *
 * Used as a safety check before DB writes; prevents accidental regressions
 * like CONFIRMED→PENDING.
 */
export function validateTransition(
  from: FinalityStatus,
  to: FinalityStatus,
): string | null {
  if (from === to) return null; // no-op is always valid
  if (TERMINAL_STATES.has(from)) {
    return `Illegal transition: cannot leave terminal state "${from}"`;
  }

  const ALLOWED: Record<FinalityStatus, ReadonlySet<FinalityStatus>> = {
    PENDING:     new Set(["CONFIRMING", "FAILED", "EXPIRED", "NOT_FOUND"]),
    CONFIRMING:  new Set(["CONFIRMED", "FAILED", "EXPIRED"]),
    CONFIRMED:   new Set(),
    FAILED:      new Set(),
    EXPIRED:     new Set(),
    NOT_FOUND:   new Set(),
  };

  if (!ALLOWED[from].has(to)) {
    return `Illegal transition: "${from}" → "${to}"`;
  }
  return null;
}
