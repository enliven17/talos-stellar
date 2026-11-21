/**
 * Public API barrel for the reconciler module.
 *
 * Other parts of the application (API routes, instrumentation) import from
 * "@/lib/reconciler" rather than from individual sub-modules.
 */
export { startReconciler, stopReconciler, runOneTick, registerTx, getStats, isRunning } from "./scheduler";
export { reconcilerConfig, loadReconcilerConfig } from "./config";
export { pollTransaction, fetchCurrentLedger } from "./horizon";
export { applyRepair } from "./repair";
export {
  buildPaymentRepairPlan,
  createDryRunRepairPlan,
  executeRepairPlan,
  verifyRepairPlanSelection,
  computePlanHash,
  computeRecordFingerprint,
  describeProposedRepair,
} from "./plan";
export type { DryRunPlanDeps, ExecutePlanDeps } from "./plan";
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
  ProposedRepairAction,
  ProposedDownstreamRepair,
  RepairPlanObservation,
  PlannedRecordSnapshot,
  PlannedProposedState,
  PlannedPaymentRepairItem,
  PaymentRepairPlan,
  RepairPlanSelection,
  RepairPlanErrorCode,
  RepairPlanExecutionItemResult,
  RepairPlanExecutionResult,
} from "./types";
export { ACTIVE_STATES, TERMINAL_STATES } from "./types";
