/**
 * Public API barrel for the reconciler module.
 *
 * Other parts of the application (API routes, instrumentation) import from
 * "@/lib/reconciler" rather than from individual sub-modules.
 */
export { startReconciler, stopReconciler, runOneTick, registerTx, getStats, isRunning } from "./scheduler";
export { reconcilerConfig, loadReconcilerConfig } from "./config";
export {
  pollTransaction,
  fetchCurrentLedger,
  classifyHorizonError,
  getFailureCategory,
  isAuthorizationFailure,
  isThrottlingFailure,
  isProviderFailure,
  extractHttpStatus,
} from "./horizon";
export { applyRepair } from "./repair";
export {
  computeTransition,
  transitionFromPending,
  transitionFromConfirming,
  needsRepair,
  validateTransition,
  isTerminal,
  isWallClockExpired,
  isLedgerExpired,
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
  HorizonProviderFailureReasonCode,
  ProviderFailureReasonCode,
  HorizonFailureReasonCode,
  HorizonFailureCategory,
} from "./types";
export {
  ACTIVE_STATES,
  TERMINAL_STATES,
  HORIZON_PROVIDER_FAILURE_REASONS,
} from "./types";
