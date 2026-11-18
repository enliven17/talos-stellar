/**
 * Public API barrel for the reconciler module.
 *
 * Other parts of the application (API routes, instrumentation) import from
 * "@/lib/reconciler" rather than from individual sub-modules.
 */
export { startReconciler, stopReconciler, runOneTick, registerTx, getStats, isRunning } from "./scheduler";
export { reconcilerConfig, loadReconcilerConfig } from "./config";
export { pollTransaction, fetchCurrentLedger, extractObservationSource } from "./horizon";
export { applyRepair } from "./repair";
export {
  recordEvidence,
  getEvidenceTrail,
  clearEvidenceTrail,
  getEvidenceCount,
  truncateTxHash,
  sanitizeEvidenceMetadata,
  DEFAULT_MAX_EVIDENCE_ENTRIES,
  MAX_READ_LIMIT,
  DEFAULT_READ_LIMIT,
} from "./evidence";
export {
  computeTransition,
  transitionFromPending,
  transitionFromConfirming,
  needsRepair,
  validateTransition,
  isTerminal,
  isWallClockExpired,
  isLedgerExpired,
  buildFinalityEvidence,
} from "./state-machine";
export type {
  FinalityStatus,
  TxSourceType,
  TxRecord,
  TxRecordUpdate,
  HorizonPollResult,
  RepairOutcome,
  ReconcilerConfig,
  ReconcilerStats,
  FinalityEvidence,
  ObservationSource,
} from "./types";
export { ACTIVE_STATES, TERMINAL_STATES } from "./types";
