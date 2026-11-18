/**
 * Public API barrel for the reconciler module.
 *
 * Other parts of the application (API routes, instrumentation) import from
 * "@/lib/reconciler" rather than from individual sub-modules.
 */
export { startReconciler, stopReconciler, runOneTick, registerTx, getStats, isRunning } from "./scheduler";
export { reconcilerConfig, loadReconcilerConfig } from "./config";
export { pollTransaction, fetchCurrentLedger, isTrustedObservation } from "./horizon";
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
  getObservationAge,
  isObservationStale,
  getPaymentObservation,
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
  ObservationStatus,
  PaymentObservation,
} from "./types";
export { ACTIVE_STATES, TERMINAL_STATES } from "./types";
