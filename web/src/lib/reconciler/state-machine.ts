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
  FinalityEvidence,
} from "./types";
import { TERMINAL_STATES } from "./types";

// ─── Evidence Builder ─────────────────────────────────────────────────────────

/**
 * Construct a standardized FinalityEvidence object for a state transition.
 */
export function buildFinalityEvidence(params: {
  record: TxRecord;
  fromStatus: FinalityStatus;
  toStatus: FinalityStatus;
  ledger: number | null;
  observationSource: string;
  transitionReason: string;
  now?: Date;
  metadata?: Record<string, unknown>;
}): FinalityEvidence {
  return {
    txHash: params.record.txHash,
    ledger: params.ledger,
    observationSource: params.observationSource,
    transitionReason: params.transitionReason,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    decidedAt: params.now ?? new Date(),
    metadata: params.metadata,
  };
}

// ─── Guard ───────────────────────────────────────────────────────────────────

/**
 * Normalise a Stellar network passphrase or shorthand network name into
 * its canonical network passphrase.
 */
export function normalizeNetworkPassphrase(
  networkOrPassphrase?: string | null,
): string | null {
  if (!networkOrPassphrase) return null;
  const trimmed = networkOrPassphrase.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "testnet") {
    return "Test SDF Network ; September 2015";
  }
  if (lower === "mainnet" || lower === "public") {
    return "Public Global Stellar Network ; September 2015";
  }
  return trimmed;
}

/**
 * Returns true if the observed network matches the expected/pinned network.
 * If either network is unknown or omitted, returns true to preserve backward
 * compatibility for unpinned records or legacy fixtures.
 */
export function isMatchingNetwork(
  expected?: string | null,
  observed?: string | null,
): boolean {
  if (!expected || !observed) return true;
  return normalizeNetworkPassphrase(expected) === normalizeNetworkPassphrase(observed);
}

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
    const reason = "Wall-clock expiry exceeded";
    const source = "wall_clock";
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: reason,
      pollCount: record.pollCount + 1,
      updatedAt: now,
      observationSource: source,
      transitionReason: reason,
      evidence: buildFinalityEvidence({
        record,
        fromStatus: "PENDING",
        toStatus: "EXPIRED",
        ledger: currentLedger,
        observationSource: source,
        transitionReason: reason,
        now,
      }),
    };
  }

  // Ledger gap expiry
  if (isLedgerExpired(record, currentLedger, config.maxLedgerGap)) {
    const reason = `Ledger gap exceeded: current=${currentLedger}, submitted=${record.ledgerSubmitted}, max=${config.maxLedgerGap}`;
    const source = "ledger_gap";
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: reason,
      pollCount: record.pollCount + 1,
      updatedAt: now,
      observationSource: source,
      transitionReason: reason,
      evidence: buildFinalityEvidence({
        record,
        fromStatus: "PENDING",
        toStatus: "EXPIRED",
        ledger: currentLedger,
        observationSource: source,
        transitionReason: reason,
        now,
      }),
    };
  }

  // Network identity check: reject observations from a foreign network without transitioning financial state
  const pinnedNetwork = record.networkPassphrase ?? config.networkPassphrase;
  if (
    pinnedNetwork &&
    pollResult.networkPassphrase &&
    !isMatchingNetwork(pinnedNetwork, pollResult.networkPassphrase)
  ) {
    return {
      lastLedgerChecked: currentLedger,
      lastError: `Rejected observation from foreign network "${pollResult.networkPassphrase}" (pinned to "${pinnedNetwork}")`,
      pollCount: record.pollCount + 1,
      updatedAt: now,
    };
  }

  switch (pollResult.outcome) {
    case "confirmed": {
      const reason = "Transaction confirmed on-chain in closed ledger";
      const source = pollResult.source ?? "horizon";
      return {
        finalityStatus: "CONFIRMING",
        lastLedgerChecked: currentLedger,
        confirmedLedger: pollResult.ledger,
        lastError: null,
        pollCount: record.pollCount + 1,
        updatedAt: now,
        observationSource: source,
        transitionReason: reason,
        evidence: buildFinalityEvidence({
          record,
          fromStatus: "PENDING",
          toStatus: "CONFIRMING",
          ledger: pollResult.ledger,
          observationSource: source,
          transitionReason: reason,
          now,
        }),
      };
    }

    case "failed": {
      const reason = pollResult.detail ?? "Transaction unsuccessful on-chain";
      const source = pollResult.source ?? "horizon";
      return {
        finalityStatus: "FAILED",
        lastLedgerChecked: currentLedger,
        confirmedLedger: pollResult.ledger,
        lastError: reason,
        pollCount: record.pollCount + 1,
        updatedAt: now,
        observationSource: source,
        transitionReason: reason,
        evidence: buildFinalityEvidence({
          record,
          fromStatus: "PENDING",
          toStatus: "FAILED",
          ledger: pollResult.ledger,
          observationSource: source,
          transitionReason: reason,
          now,
          metadata: pollResult.detail ? { resultCode: pollResult.detail } : undefined,
        }),
      };
    }

    case "not_found": {
      const newPollCount = record.pollCount + 1;
      if (newPollCount >= config.notFoundThreshold) {
        const reason = `NOT_FOUND after ${newPollCount} polls`;
        const source = pollResult.source ?? "horizon";
        return {
          finalityStatus: "NOT_FOUND",
          lastLedgerChecked: currentLedger,
          lastError: reason,
          pollCount: newPollCount,
          updatedAt: now,
          observationSource: source,
          transitionReason: reason,
          evidence: buildFinalityEvidence({
            record,
            fromStatus: "PENDING",
            toStatus: "NOT_FOUND",
            ledger: currentLedger,
            observationSource: source,
            transitionReason: reason,
            now,
            metadata: { pollCount: newPollCount, threshold: config.notFoundThreshold },
          }),
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
  pollResult?: HorizonPollResult | null,
): TxRecordUpdate | null {
  if (record.finalityStatus !== "CONFIRMING") return null;

  // Wall-clock expiry
  if (isWallClockExpired(record, now)) {
    const reason = "Confirmation window expired (wall-clock)";
    const source = "wall_clock";
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: reason,
      updatedAt: now,
      observationSource: source,
      transitionReason: reason,
      evidence: buildFinalityEvidence({
        record,
        fromStatus: "CONFIRMING",
        toStatus: "EXPIRED",
        ledger: currentLedger,
        observationSource: source,
        transitionReason: reason,
        now,
      }),
    };
  }

  // Network identity check: reject observations from a foreign network without transitioning financial state
  const pinnedNetwork = record.networkPassphrase ?? config.networkPassphrase;
  if (
    pinnedNetwork &&
    pollResult &&
    pollResult.networkPassphrase &&
    !isMatchingNetwork(pinnedNetwork, pollResult.networkPassphrase)
  ) {
    return {
      lastLedgerChecked: currentLedger,
      lastError: `Rejected observation from foreign network "${pollResult.networkPassphrase}" (pinned to "${pinnedNetwork}")`,
      updatedAt: now,
    };
  }

  // Ledger gap for confirming: count from the ledger it was first seen in
  if (
    record.ledgerSubmitted &&
    isLedgerExpired(record, currentLedger, config.maxLedgerGap)
  ) {
    const reason = `Confirmation ledger gap exceeded: current=${currentLedger}`;
    const source = "ledger_gap";
    return {
      finalityStatus: "EXPIRED",
      lastLedgerChecked: currentLedger,
      lastError: reason,
      updatedAt: now,
      observationSource: source,
      transitionReason: reason,
      evidence: buildFinalityEvidence({
        record,
        fromStatus: "CONFIRMING",
        toStatus: "EXPIRED",
        ledger: currentLedger,
        observationSource: source,
        transitionReason: reason,
        now,
      }),
    };
  }

  // Check depth
  if (
    record.confirmedLedger !== null &&
    record.confirmedLedger !== undefined &&
    currentLedger >= record.confirmedLedger + config.confirmationDepth
  ) {
    const reason = `Confirmation depth reached: current=${currentLedger}, confirmed=${record.confirmedLedger}, depth=${config.confirmationDepth}`;
    const source = "horizon";
    return {
      finalityStatus: "CONFIRMED",
      lastLedgerChecked: currentLedger,
      lastError: null,
      updatedAt: now,
      observationSource: source,
      transitionReason: reason,
      evidence: buildFinalityEvidence({
        record,
        fromStatus: "CONFIRMING",
        toStatus: "CONFIRMED",
        ledger: currentLedger,
        observationSource: source,
        transitionReason: reason,
        now,
        metadata: {
          confirmedLedger: record.confirmedLedger,
          confirmationDepth: config.confirmationDepth,
        },
      }),
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

  // Ledger regression check: reject observations from older ledgers than
  // previously seen to prevent re-processing stale Horizon data.
  if (record.lastLedgerChecked !== null && currentLedger < record.lastLedgerChecked) {
    return {
      lastError: `Ledger regression detected: current=${currentLedger} < last=${record.lastLedgerChecked}`,
      updatedAt: now,
    };
  }

  switch (record.finalityStatus) {
    case "PENDING":
      if (!pollResult) return null;
      return transitionFromPending(record, pollResult, currentLedger, config, now);

    case "CONFIRMING":
      return transitionFromConfirming(record, currentLedger, config, now, pollResult);

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
