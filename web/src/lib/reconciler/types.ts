/**
 * Shared types for the Stellar transaction finality reconciler.
 *
 * Keeping types in a dedicated module ensures the state machine, polling
 * layer, repair logic, and scheduler all share a single canonical set of
 * discriminated unions — avoiding stringly-typed bugs across module boundaries.
 */

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
}
