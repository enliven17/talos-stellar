/**
 * Dry-run payment repair planning and guarded execution for the finality reconciler.
 *
 * Operators can generate a dry-run repair plan that inspects Horizon
 * observations and computes proposed state transitions and downstream repairs
 * without mutating any database rows.  Execution requires an explicit
 * selection of record IDs and verifies that:
 *   1. The plan payload has not been modified since generation (planHash check).
 *   2. Every selected record's persisted state is unchanged (recordFingerprint check).
 *   3. Only the explicitly selected records are executed.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { tlsStellarTxRecords } from "@/db/schema";
import { reconcilerConfig } from "./config";
import { fetchCurrentLedger, pollTransaction } from "./horizon";
import { applyRepair } from "./repair";
import {
  computeTransition,
  isLedgerExpired,
  isWallClockExpired,
  needsRepair,
  validateTransition,
} from "./state-machine";
import type {
  FinalityStatus,
  HorizonPollResult,
  PaymentRepairPlan,
  PlannedPaymentRepairItem,
  PlannedProposedState,
  PlannedRecordSnapshot,
  ProposedDownstreamRepair,
  ReconcilerConfig,
  RepairOutcome,
  RepairPlanExecutionItemResult,
  RepairPlanExecutionResult,
  RepairPlanObservation,
  RepairPlanSelection,
  TxRecord,
  TxRecordUpdate,
  TxSourceType,
} from "./types";
import { ACTIVE_STATES, TERMINAL_STATES } from "./types";

// ─── Fingerprinting & hashing ────────────────────────────────────────────────

function sha256Hex(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toIsoString(date: Date | string): string {
  return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
}

/**
 * Deterministic fingerprint of a transaction record's mutable reconciliation state.
 * Any concurrent update to the record changes this fingerprint.
 */
export function computeRecordFingerprint(
  record: Pick<
    TxRecord,
    | "id"
    | "txHash"
    | "sourceType"
    | "sourceId"
    | "finalityStatus"
    | "confirmedLedger"
    | "pollCount"
    | "repairApplied"
    | "updatedAt"
  >,
): string {
  return sha256Hex({
    id: record.id,
    txHash: record.txHash,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    finalityStatus: record.finalityStatus,
    confirmedLedger: record.confirmedLedger,
    pollCount: record.pollCount,
    repairApplied: record.repairApplied,
    updatedAt: toIsoString(record.updatedAt),
  });
}

/**
 * Deterministic hash of a payment repair plan's canonical content.
 * Excludes `planId` and `planHash` themselves so callers can verify integrity.
 */
export function computePlanHash(
  plan: Pick<PaymentRepairPlan, "createdAt" | "currentLedger" | "horizonUrl" | "items">,
): string {
  return sha256Hex({
    createdAt: plan.createdAt,
    currentLedger: plan.currentLedger,
    horizonUrl: plan.horizonUrl,
    items: plan.items,
  });
}

// ─── Pure proposed repair description ────────────────────────────────────────

/**
 * Purely describe the downstream repair that `applyRepair()` would perform
 * when a record is in `finalityStatus` with `repairApplied=false`.
 */
export function describeProposedRepair(
  sourceType: TxSourceType,
  sourceId: string | null,
  finalityStatus: FinalityStatus,
  repairApplied: boolean,
): ProposedDownstreamRepair {
  if (repairApplied || !TERMINAL_STATES.has(finalityStatus)) {
    return {
      action: "none",
      targetTable: null,
      targetStatus: null,
      detail: repairApplied
        ? "Repair already applied"
        : `Record in non-terminal state ${finalityStatus}; no downstream repair yet`,
    };
  }

  if (sourceType === "commerce_job") {
    if (!sourceId) {
      return {
        action: "none",
        targetTable: "tls_commerce_jobs",
        targetStatus: null,
        detail: "No sourceId for commerce_job repair",
      };
    }
    switch (finalityStatus) {
      case "CONFIRMED":
        return {
          action: "mark_confirmed",
          targetTable: "tls_commerce_jobs",
          targetStatus: null,
          detail: "Payment confirmed; job remains pending for fulfillment",
        };
      case "FAILED":
        return {
          action: "mark_failed",
          targetTable: "tls_commerce_jobs",
          targetStatus: "payment_failed",
          detail: "Job status -> payment_failed (if still pending)",
        };
      case "EXPIRED":
        return {
          action: "mark_expired",
          targetTable: "tls_commerce_jobs",
          targetStatus: "payment_expired",
          detail: "Job status -> payment_expired (if still pending)",
        };
      case "NOT_FOUND":
        return {
          action: "mark_not_found",
          targetTable: "tls_commerce_jobs",
          targetStatus: "payment_not_found",
          detail: "Job status -> payment_not_found (if still pending)",
        };
    }
  }

  if (sourceType === "token_purchase") {
    if (finalityStatus === "CONFIRMED") {
      return {
        action: "mark_confirmed",
        targetTable: "tls_token_purchases",
        targetStatus: null,
        detail: "Verify token purchase completed; flag for manual review if still pending",
      };
    }
    return {
      action: "mark_failed",
      targetTable: "tls_token_purchases",
      targetStatus: "failed",
      detail: `Token purchase status -> failed due to ${finalityStatus} (if still pending)`,
    };
  }

  return {
    action: "none",
    targetTable: null,
    targetStatus: null,
    detail: "sourceType=other: no structured downstream repair needed",
  };
}

// ─── Observation builder ─────────────────────────────────────────────────────

function buildObservation(
  record: TxRecord,
  pollResult: HorizonPollResult | null,
  currentLedger: number,
  config: ReconcilerConfig,
  now: Date,
  update: TxRecordUpdate | null,
): RepairPlanObservation {
  const wallClockExpired = isWallClockExpired(record, now);
  const ledgerExpired = isLedgerExpired(record, currentLedger, config.maxLedgerGap);
  const ledgerGap =
    record.ledgerSubmitted !== null ? currentLedger - record.ledgerSubmitted : null;
  const confirmationDepthMet =
    record.finalityStatus === "CONFIRMING" && record.confirmedLedger !== null
      ? currentLedger >= record.confirmedLedger + config.confirmationDepth
      : null;

  let reason: string;
  if (TERMINAL_STATES.has(record.finalityStatus)) {
    reason = record.repairApplied
      ? `Record already in terminal state ${record.finalityStatus} with repair applied`
      : `Record in terminal state ${record.finalityStatus} awaiting downstream repair`;
  } else if (wallClockExpired) {
    reason = "Wall-clock expiresAt exceeded";
  } else if (ledgerExpired) {
    reason = `Ledger gap ${ledgerGap} exceeded maxLedgerGap=${config.maxLedgerGap}`;
  } else if (record.finalityStatus === "PENDING") {
    if (!pollResult) {
      reason = "No Horizon poll result available";
    } else if (pollResult.outcome === "confirmed") {
      reason = `Horizon observed successful tx in ledger ${pollResult.ledger}`;
    } else if (pollResult.outcome === "failed") {
      reason = `Horizon observed failed tx in ledger ${pollResult.ledger} (${pollResult.detail ?? "tx_failed"})`;
    } else if (pollResult.outcome === "not_found") {
      const nextCount = record.pollCount + 1;
      reason =
        nextCount >= config.notFoundThreshold
          ? `Horizon returned 404 (${nextCount}/${config.notFoundThreshold}); threshold reached`
          : `Horizon returned 404 (${nextCount}/${config.notFoundThreshold}); remaining PENDING`;
    } else {
      reason = `Transient Horizon error (${pollResult.message}); remaining PENDING`;
    }
  } else if (record.finalityStatus === "CONFIRMING") {
    reason = confirmationDepthMet
      ? `Confirmation depth reached (currentLedger=${currentLedger} >= ${record.confirmedLedger}+${config.confirmationDepth})`
      : `Awaiting confirmation depth (currentLedger=${currentLedger}, confirmedLedger=${record.confirmedLedger}, depth=${config.confirmationDepth})`;
  } else if (update?.finalityStatus) {
    reason = `Transition ${record.finalityStatus} -> ${update.finalityStatus}`;
  } else {
    reason = "No state change proposed";
  }

  return {
    currentLedger,
    pollResult,
    ledgerGap,
    confirmationDepthMet,
    wallClockExpired,
    ledgerExpired,
    reason,
  };
}

// ─── Pure dry-run plan builder ───────────────────────────────────────────────

/**
 * Build a deterministic dry-run payment repair plan from records and their
 * Horizon observations. Performs zero I/O and zero database writes.
 */
export function buildPaymentRepairPlan(
  records: TxRecord[],
  observationsByRecordId: ReadonlyMap<string, HorizonPollResult | null>,
  currentLedger: number,
  config: ReconcilerConfig,
  now: Date = new Date(),
): PaymentRepairPlan {
  const items: PlannedPaymentRepairItem[] = records.map((record) => {
    const pollResult = observationsByRecordId.get(record.id) ?? null;
    const update = computeTransition(record, pollResult, currentLedger, config, now);

    const nextStatus: FinalityStatus = update?.finalityStatus ?? record.finalityStatus;
    const nextConfirmedLedger =
      update?.confirmedLedger !== undefined ? update.confirmedLedger : record.confirmedLedger;
    const nextPollCount = update?.pollCount ?? record.pollCount;
    const nextLastError =
      update?.lastError !== undefined ? update.lastError : record.lastError;

    const afterTransition: TxRecord = {
      ...record,
      finalityStatus: nextStatus,
      confirmedLedger: nextConfirmedLedger,
      pollCount: nextPollCount,
      lastError: nextLastError,
    };

    const willNeedRepair = needsRepair(afterTransition);
    const proposedRepair = describeProposedRepair(
      record.sourceType,
      record.sourceId,
      nextStatus,
      record.repairApplied,
    );

    const currentState: PlannedRecordSnapshot = {
      finalityStatus: record.finalityStatus,
      confirmedLedger: record.confirmedLedger,
      pollCount: record.pollCount,
      repairApplied: record.repairApplied,
      updatedAt: toIsoString(record.updatedAt),
    };

    const proposedState: PlannedProposedState = {
      finalityStatus: nextStatus,
      confirmedLedger: nextConfirmedLedger,
      pollCount: nextPollCount,
      lastError: nextLastError,
      repairApplied: willNeedRepair ? true : record.repairApplied,
    };

    const observations = buildObservation(
      record,
      pollResult,
      currentLedger,
      config,
      now,
      update,
    );

    const stateChanges =
      nextStatus !== record.finalityStatus ||
      nextConfirmedLedger !== record.confirmedLedger ||
      nextPollCount !== record.pollCount ||
      nextLastError !== record.lastError;

    return {
      recordId: record.id,
      txHash: record.txHash,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      currentState,
      proposedState,
      proposedRepair,
      observations,
      requiresExecution: stateChanges || willNeedRepair,
      recordFingerprint: computeRecordFingerprint(record),
    };
  });

  const createdAt = now.toISOString();
  const planHash = computePlanHash({
    createdAt,
    currentLedger,
    horizonUrl: config.horizonUrl,
    items,
  });

  return {
    planId: `plan_${planHash.slice(0, 16)}`,
    planHash,
    createdAt,
    currentLedger,
    horizonUrl: config.horizonUrl,
    items,
  };
}

// ─── Dry-run plan creation (read-only I/O) ───────────────────────────────────

export interface DryRunPlanDeps {
  fetchCurrentLedger?: (horizonUrl: string) => Promise<number | null>;
  pollTransaction?: (txHash: string, horizonUrl: string) => Promise<HorizonPollResult>;
  loadCandidateRecords?: (batchSize: number) => Promise<TxRecord[]>;
  now?: () => Date;
}

async function defaultLoadCandidateRecords(batchSize: number): Promise<TxRecord[]> {
  const activeStatuses = Array.from(ACTIVE_STATES) as string[];
  const terminalStatuses = Array.from(TERMINAL_STATES) as string[];

  return (await db
    .select()
    .from(tlsStellarTxRecords)
    .where(
      or(
        inArray(tlsStellarTxRecords.finalityStatus, activeStatuses),
        and(
          inArray(tlsStellarTxRecords.finalityStatus, terminalStatuses),
          eq(tlsStellarTxRecords.repairApplied, false),
        ),
      ),
    )
    .orderBy(tlsStellarTxRecords.updatedAt)
    .limit(batchSize)) as TxRecord[];
}

/**
 * Create a dry-run payment repair plan using live (or injected) Horizon
 * observations. Performs NO database writes.
 *
 * Returns `null` if Horizon is unreachable (`currentLedger === null`).
 */
export async function createDryRunRepairPlan(
  config: ReconcilerConfig = reconcilerConfig,
  deps: DryRunPlanDeps = {},
): Promise<PaymentRepairPlan | null> {
  const getLedger = deps.fetchCurrentLedger ?? fetchCurrentLedger;
  const pollTx = deps.pollTransaction ?? pollTransaction;
  const loadRecords = deps.loadCandidateRecords ?? defaultLoadCandidateRecords;
  const now = (deps.now ?? (() => new Date()))();

  const currentLedger = await getLedger(config.horizonUrl);
  if (currentLedger === null) {
    return null;
  }

  const records = await loadRecords(config.batchSize);
  const observations = new Map<string, HorizonPollResult | null>();

  for (const record of records) {
    if (record.finalityStatus === "PENDING") {
      observations.set(record.id, await pollTx(record.txHash, config.horizonUrl));
    } else {
      observations.set(record.id, null);
    }
  }

  return buildPaymentRepairPlan(records, observations, currentLedger, config, now);
}

// ─── Guarded execution of an explicitly selected unchanged plan ──────────────

export interface ExecutePlanDeps {
  loadRecordsByIds?: (ids: string[]) => Promise<TxRecord[]>;
  updateRecord?: (id: string, update: TxRecordUpdate) => Promise<void>;
  applyRepair?: (record: TxRecord) => Promise<RepairOutcome>;
  now?: () => Date;
}

async function defaultLoadRecordsByIds(ids: string[]): Promise<TxRecord[]> {
  if (ids.length === 0) return [];
  return (await db
    .select()
    .from(tlsStellarTxRecords)
    .where(inArray(tlsStellarTxRecords.id, ids))) as TxRecord[];
}

async function defaultUpdateRecord(id: string, update: TxRecordUpdate): Promise<void> {
  await db
    .update(tlsStellarTxRecords)
    .set(update)
    .where(eq(tlsStellarTxRecords.id, id));
}

/**
 * Pure validation of a plan + explicit selection against current persisted records.
 * Returns null if valid, or a structured failure result if anything changed or is invalid.
 */
export function verifyRepairPlanSelection(
  plan: PaymentRepairPlan,
  currentRecords: TxRecord[],
  selection: RepairPlanSelection,
): Extract<RepairPlanExecutionResult, { ok: false }> | null {
  // 1. Verify plan integrity (plan must be unchanged since dry-run)
  const expectedHash = computePlanHash(plan);
  if (selection.planHash !== expectedHash || plan.planHash !== expectedHash) {
    return {
      ok: false,
      code: "PLAN_MODIFIED",
      error: "Repair plan hash mismatch: the plan was modified or does not match the selected planHash",
    };
  }

  // 2. Verify explicit non-empty selection of valid record IDs in this plan
  if (!Array.isArray(selection.selectedRecordIds) || selection.selectedRecordIds.length === 0) {
    return {
      ok: false,
      code: "INVALID_SELECTION",
      error: "At least one recordId must be explicitly selected for execution",
    };
  }

  const itemById = new Map(plan.items.map((item) => [item.recordId, item]));
  const uniqueSelectedIds = Array.from(new Set(selection.selectedRecordIds));

  for (const id of uniqueSelectedIds) {
    if (!itemById.has(id)) {
      return {
        ok: false,
        code: "INVALID_SELECTION",
        error: `Selected recordId "${id}" is not part of plan ${plan.planId}`,
      };
    }
  }

  // 3. Verify every selected record is unchanged since dry-run
  const currentById = new Map(currentRecords.map((r) => [r.id, r]));
  const changedRecordIds: string[] = [];

  for (const id of uniqueSelectedIds) {
    const plannedItem = itemById.get(id)!;
    const currentRecord = currentById.get(id);
    if (!currentRecord) {
      changedRecordIds.push(id);
      continue;
    }
    const currentFingerprint = computeRecordFingerprint(currentRecord);
    if (currentFingerprint !== plannedItem.recordFingerprint) {
      changedRecordIds.push(id);
      continue;
    }

    // 4. Verify transition legality
    const transitionErr = validateTransition(
      currentRecord.finalityStatus,
      plannedItem.proposedState.finalityStatus,
    );
    if (transitionErr) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        error: `Record ${id}: ${transitionErr}`,
      };
    }
  }

  if (changedRecordIds.length > 0) {
    return {
      ok: false,
      code: "RECORD_CHANGED",
      error: `Selected record(s) changed since dry-run plan was generated: ${changedRecordIds.join(", ")}`,
      changedRecordIds,
    };
  }

  return null;
}

/**
 * Execute ONLY the explicitly selected records from an unchanged dry-run
 * payment repair plan. If any integrity or drift check fails, zero records
 * are mutated.
 */
export async function executeRepairPlan(
  plan: PaymentRepairPlan,
  selection: RepairPlanSelection,
  deps: ExecutePlanDeps = {},
): Promise<RepairPlanExecutionResult> {
  const loadRecordsByIds = deps.loadRecordsByIds ?? defaultLoadRecordsByIds;
  const updateRecord = deps.updateRecord ?? defaultUpdateRecord;
  const runRepair = deps.applyRepair ?? applyRepair;
  const now = (deps.now ?? (() => new Date()))();

  const uniqueSelectedIds = Array.isArray(selection.selectedRecordIds)
    ? Array.from(new Set(selection.selectedRecordIds))
    : [];

  const currentRecords =
    uniqueSelectedIds.length > 0 ? await loadRecordsByIds(uniqueSelectedIds) : [];

  const validationError = verifyRepairPlanSelection(plan, currentRecords, selection);
  if (validationError) {
    return validationError;
  }

  const itemById = new Map(plan.items.map((item) => [item.recordId, item]));
  const currentById = new Map(currentRecords.map((r) => [r.id, r]));
  const results: RepairPlanExecutionItemResult[] = [];
  let executedCount = 0;
  let skippedCount = 0;

  for (const id of uniqueSelectedIds) {
    const planned = itemById.get(id)!;
    const current = currentById.get(id)!;

    if (!planned.requiresExecution) {
      skippedCount++;
      results.push({
        recordId: id,
        txHash: current.txHash,
        previousStatus: current.finalityStatus,
        newStatus: current.finalityStatus,
        repairApplied: current.repairApplied,
        detail: "No changes required",
      });
      continue;
    }

    const stateUpdate: TxRecordUpdate = {
      finalityStatus: planned.proposedState.finalityStatus,
      lastLedgerChecked: plan.currentLedger,
      confirmedLedger: planned.proposedState.confirmedLedger ?? undefined,
      pollCount: planned.proposedState.pollCount,
      lastError: planned.proposedState.lastError,
      updatedAt: now,
    };

    await updateRecord(id, stateUpdate);

    const updatedRecord: TxRecord = {
      ...current,
      finalityStatus: planned.proposedState.finalityStatus,
      confirmedLedger: planned.proposedState.confirmedLedger,
      pollCount: planned.proposedState.pollCount,
      lastError: planned.proposedState.lastError,
      updatedAt: now,
    };

    let repairApplied = current.repairApplied;
    let detail: string | undefined = planned.observations.reason;

    if (needsRepair(updatedRecord)) {
      const outcome = await runRepair(updatedRecord);
      if (outcome.ok) {
        repairApplied = true;
        detail = outcome.detail ?? detail;
        await updateRecord(id, { repairApplied: true, updatedAt: now });
      } else {
        detail = outcome.error;
      }
    }

    executedCount++;
    results.push({
      recordId: id,
      txHash: current.txHash,
      previousStatus: current.finalityStatus,
      newStatus: updatedRecord.finalityStatus,
      repairApplied,
      detail,
    });
  }

  return {
    ok: true,
    planId: plan.planId,
    planHash: plan.planHash,
    executedCount,
    skippedCount,
    items: results,
  };
}
