/**
 * Shared types for the Stellar transaction finality reconciler.
 *
 * Keeping types in a dedicated module ensures the state machine, polling
 * layer, repair logic, and scheduler all share a single canonical set of
 * discriminated unions — avoiding stringly-typed bugs across module boundaries.
 */

// ─── Replayable Report Types ─────────────────────────────────────────────────

export interface ReconcilerObservation {
  pollResult: HorizonPollResult | null;
  currentLedger: number;
  now: Date;
}

export interface ReconcilerTransitionReport {
  initialState: TxRecord;
  steps: {
    observation: ReconcilerObservation;
    update: TxRecordUpdate | null;
    resultingState: TxRecord;
  }[];
}

// ─── Finality States ──────────────────────────────────────────────────────────

/** All valid positions in the finality state machine. */
export type FinalityStatus =
  | "PENDING"      // submitted, not yet seen on Horizon
  | "CONFIRMING"   // seen on Horizon, within reorg-safety window
  | "CONFIRMED"    // permanently settled; repair has been/will be applied
  | "FAILED"       // on-chain but unsuccessful (e.g. sequence mismatch)
  | "EXPIRED"      // never confirmed within the ledger-gap window
  | "NOT_FOUND";   // repeated 404s past the NOT_FOUND threshold

/** States that allow further polling. */
export const ACTIVE_STATES: ReadonlySet<FinalityStatus> = new Set([
  "PENDING",
  "CONFIRMING",
]);

/** States where no further polling or repair should occur. */
export const TERMINAL_STATES: ReadonlySet<FinalityStatus> = new Set([
  "CONFIRMED",
  "FAILED",
  "EXPIRED",
  "NOT_FOUND",
]);

// ─── Source Types ─────────────────────────────────────────────────────────────

/** Which subsystem originated the tracked transaction. */
export type TxSourceType = "commerce_job" | "token_purchase" | "other";

// ─── Persisted Record ─────────────────────────────────────────────────────────

/** Shape of a row in tls_stellar_tx_records as returned by the DB layer. */
export interface TxRecord {
  id: string;
  txHash: string;
  sourceType: TxSourceType;
  sourceId: string | null;
  finalityStatus: FinalityStatus;
  ledgerSubmitted: number | null;
  lastLedgerChecked: number | null;
  confirmedLedger: number | null;
  pollCount: number;
  lastError: string | null;
  repairApplied: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Horizon Poll Result ──────────────────────────────────────────────────────

/** Discriminated union returned by the Horizon polling layer. */
export type HorizonPollResult =
  | { outcome: "confirmed"; ledger: number; successful: true }
  | { outcome: "failed";    ledger: number; successful: false; detail?: string }
  | { outcome: "not_found" }
  | { outcome: "error";     message: string; retryable: boolean };

// ─── State Transition ─────────────────────────────────────────────────────────

/** Fields that may be updated during a state transition. */
export interface TxRecordUpdate {
  finalityStatus?: FinalityStatus;
  lastLedgerChecked?: number;
  confirmedLedger?: number;
  pollCount?: number;
  lastError?: string | null;
  repairApplied?: boolean;
  updatedAt?: Date;
}

// ─── Repair Result ────────────────────────────────────────────────────────────

/** Outcome of applying downstream repair for a confirmed/failed/expired tx. */
export type RepairOutcome =
  | { ok: true;  repaired: boolean; detail?: string }
  | { ok: false; error: string };

// ─── Reconciler Config ────────────────────────────────────────────────────────

/** Runtime configuration, resolved once at startup from env vars. */
export interface ReconcilerConfig {
  /** Whether the reconciler background loop is active. Default: false. */
  enabled: boolean;

  /** How often the scheduler wakes up, in milliseconds. Default: 30_000. */
  pollIntervalMs: number;

  /**
   * Maximum ledger gap before a PENDING/CONFIRMING tx is transitioned to EXPIRED.
   * On Stellar testnet a ledger closes roughly every 5 s; 120 ledgers ≈ 10 min.
   * Default: 120.
   */
  maxLedgerGap: number;

  /**
   * Number of consecutive NOT_FOUND poll results before the record transitions
   * to the NOT_FOUND terminal state.  Default: 10.
   */
  notFoundThreshold: number;

  /**
   * Maximum number of non-terminal records to process in a single scheduler
   * tick.  Bounds memory and Horizon request rate.  Default: 50.
   */
  batchSize: number;

  /** Horizon base URL. */
  horizonUrl: string;

  /**
   * Number of ledgers to wait after first-seen before considering a tx
   * CONFIRMED (reorg-safety depth).  Default: 1 (Stellar has instant finality
   * after ledger close; set higher if you want belt-and-suspenders).
   */
  confirmationDepth: number;

  /**
   * Maximum number of concurrent database/Horizon operations allowed.
   * Default: 5.
   */
  concurrencyLimit?: number;
}

// ─── Scheduler State (in-process singleton) ──────────────────────────────────

export interface ReconcilerStats {
  startedAt: Date | null;
  lastTickAt: Date | null;
  lastTickDurationMs: number | null;
  tickCount: number;
  totalConfirmed: number;
  totalFailed: number;
  totalExpired: number;
  totalNotFound: number;
  totalRepairsApplied: number;
  totalErrors: number;
  activeCount?: number;
  queueCount?: number;
}

// ─── Dry-Run Payment Repair Plan ─────────────────────────────────────────────

/** Proposed downstream repair action for a transaction record. */
export type ProposedRepairAction =
  | "none"
  | "mark_confirmed"
  | "mark_failed"
  | "mark_expired"
  | "mark_not_found"
  | "manual_review";

/** Pure description of the downstream repair that would be applied. */
export interface ProposedDownstreamRepair {
  action: ProposedRepairAction;
  targetTable: "tls_commerce_jobs" | "tls_token_purchases" | null;
  targetStatus: string | null;
  detail: string;
}

/** Supporting Horizon and ledger observations that justify a planned change. */
export interface RepairPlanObservation {
  currentLedger: number;
  pollResult: HorizonPollResult | null;
  ledgerGap: number | null;
  confirmationDepthMet: boolean | null;
  wallClockExpired: boolean;
  ledgerExpired: boolean;
  reason: string;
}

/** Snapshot of a record's state at the moment the dry-run plan was built. */
export interface PlannedRecordSnapshot {
  finalityStatus: FinalityStatus;
  confirmedLedger: number | null;
  pollCount: number;
  repairApplied: boolean;
  updatedAt: string;
}

/** Proposed state after applying the transition and/or repair. */
export interface PlannedProposedState {
  finalityStatus: FinalityStatus;
  confirmedLedger: number | null;
  pollCount: number;
  lastError: string | null;
  repairApplied: boolean;
}

/** Single item in a dry-run payment repair plan. */
export interface PlannedPaymentRepairItem {
  recordId: string;
  txHash: string;
  sourceType: TxSourceType;
  sourceId: string | null;
  currentState: PlannedRecordSnapshot;
  proposedState: PlannedProposedState;
  proposedRepair: ProposedDownstreamRepair;
  observations: RepairPlanObservation;
  requiresExecution: boolean;
  recordFingerprint: string;
}

/** Dry-run payment repair plan produced before applying reconciliation repairs. */
export interface PaymentRepairPlan {
  planId: string;
  planHash: string;
  createdAt: string;
  currentLedger: number;
  horizonUrl: string;
  items: PlannedPaymentRepairItem[];
}

/** Explicit operator selection required to execute an unchanged repair plan. */
export interface RepairPlanSelection {
  planHash: string;
  selectedRecordIds: string[];
}

/** Error codes returned when a repair plan cannot be executed safely. */
export type RepairPlanErrorCode =
  | "PLAN_MODIFIED"
  | "INVALID_SELECTION"
  | "RECORD_CHANGED"
  | "INVALID_TRANSITION";

/** Result of validating or executing a dry-run payment repair plan. */
export interface RepairPlanExecutionItemResult {
  recordId: string;
  txHash: string;
  previousStatus: FinalityStatus;
  newStatus: FinalityStatus;
  repairApplied: boolean;
  detail?: string;
}

export type RepairPlanExecutionResult =
  | {
      ok: true;
      planId: string;
      planHash: string;
      executedCount: number;
      skippedCount: number;
      items: RepairPlanExecutionItemResult[];
    }
  | {
      ok: false;
      code: RepairPlanErrorCode;
      error: string;
      changedRecordIds?: string[];
    };
