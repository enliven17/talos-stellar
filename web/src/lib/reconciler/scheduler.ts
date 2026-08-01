/**
 * Reconciler scheduler — the background loop that drives the finality state
 * machine.
 *
 * Design
 * ──────
 * The scheduler is a process-level singleton backed by a globalThis reference
 * so Next.js hot-reloads during development don't spawn duplicate loops.
 * In production (Vercel/Railway) the process starts once; the singleton pattern
 * ensures a single loop even across multiple Next.js server-component renders
 * that import this module.
 *
 * Each tick:
 *   1. Fetch current Horizon ledger.
 *   2. Load a bounded batch of non-terminal tx records from the DB.
 *   3. For each record:
 *      a. Poll Horizon for the transaction status.
 *      b. Compute the state transition (pure, via state-machine.ts).
 *      c. Validate the transition.
 *      d. Persist the update atomically.
 *      e. If the record is now terminal and needs repair, apply it.
 *   4. Update in-process stats (no DB write needed for observability).
 *
 * Structured logging uses the project's pino logger.  Every log entry includes
 * at least { txHash, finalityStatus } so operators can trace individual
 * transactions.  No secrets, wallet keys, or payload content are logged.
 *
 * Observability
 * ─────────────
 * The module exports:
 *   - getStats()      — snapshot of runtime counters
 *   - startReconciler() — idempotent start
 *   - stopReconciler()  — graceful shutdown
 *   - runOneTick()    — run a single tick synchronously (used by force endpoint
 *                        and integration tests)
 */

import { eq, inArray } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "@/db";
import { tlsStellarTxRecords } from "@/db/schema";
import { logger } from "@/lib/logger";
import { reconcilerConfig } from "./config";
import {
  computeTransition,
  needsRepair,
  validateTransition,
  isTerminal,
} from "./state-machine";
import { pollTransaction, fetchCurrentLedger } from "./horizon";
import { applyRepair } from "./repair";
import type {
  TxRecord,
  ReconcilerConfig,
  ReconcilerStats,
  FinalityStatus,
} from "./types";
import { ACTIVE_STATES } from "./types";

// ─── Singleton bookkeeping ────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & {
  __reconcilerTimer?: ReturnType<typeof setInterval> | null;
  __reconcilerStats?: ReconcilerStats;
};

function getOrInitStats(): ReconcilerStats {
  if (!g.__reconcilerStats) {
    g.__reconcilerStats = {
      startedAt: null,
      lastTickAt: null,
      lastTickDurationMs: null,
      tickCount: 0,
      totalConfirmed: 0,
      totalFailed: 0,
      totalExpired: 0,
      totalNotFound: 0,
      totalRepairsApplied: 0,
      totalErrors: 0,
    };
  }
  return g.__reconcilerStats;
}

/** Returns a snapshot of the current reconciler stats (safe to serialise). */
export function getStats(): ReconcilerStats {
  return { ...getOrInitStats() };
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

/**
 * Start the background reconciler loop.
 * Safe to call multiple times — subsequent calls are no-ops if already running.
 */
export function startReconciler(config: ReconcilerConfig = reconcilerConfig): void {
  if (!config.enabled) {
    logger.info({ enabled: false }, "reconciler_disabled");
    return;
  }

  if (g.__reconcilerTimer) {
    logger.debug("reconciler_already_running");
    return;
  }

  const stats = getOrInitStats();
  stats.startedAt = new Date();

  logger.info(
    {
      pollIntervalMs: config.pollIntervalMs,
      maxLedgerGap: config.maxLedgerGap,
      batchSize: config.batchSize,
      confirmationDepth: config.confirmationDepth,
    },
    "reconciler_started",
  );

  // Fire immediately then on interval
  void runOneTick(config).catch((err) =>
    logger.error({ err }, "reconciler_tick_uncaught"),
  );

  g.__reconcilerTimer = setInterval(() => {
    void runOneTick(config).catch((err) =>
      logger.error({ err }, "reconciler_tick_uncaught"),
    );
  }, config.pollIntervalMs);
}

/**
 * Stop the background reconciler loop gracefully.
 */
export function stopReconciler(): void {
  if (g.__reconcilerTimer) {
    clearInterval(g.__reconcilerTimer);
    g.__reconcilerTimer = null;
    logger.info("reconciler_stopped");
  }
}

/** Returns true if the reconciler timer is currently running. */
export function isRunning(): boolean {
  return !!g.__reconcilerTimer;
}

// ─── Core tick ────────────────────────────────────────────────────────────────

/**
 * Run one full reconciliation tick.
 *
 * Exported for the force-reconcile API endpoint and integration tests.
 * Returns a summary of what happened during the tick.
 */
export async function runOneTick(
  config: ReconcilerConfig = reconcilerConfig,
): Promise<TickSummary> {
  const stats = getOrInitStats();
  const tickStart = Date.now();
  const summary: TickSummary = {
    processed: 0,
    confirmed: 0,
    failed: 0,
    expired: 0,
    notFound: 0,
    repairsApplied: 0,
    errors: 0,
    currentLedger: null,
  };

  try {
    // 1. Fetch current ledger (needed for expiry checks and depth calculations)
    const currentLedger = await fetchCurrentLedger(config.horizonUrl);
    summary.currentLedger = currentLedger;

    if (currentLedger === null) {
      logger.warn({ horizonUrl: config.horizonUrl }, "reconciler_tick_no_ledger");
      stats.totalErrors++;
      summary.errors++;
      return summary;
    }

    // 2. Load a bounded batch of non-terminal records
    const activeStatuses = Array.from(ACTIVE_STATES) as string[];
    const records = await db
      .select()
      .from(tlsStellarTxRecords)
      .where(inArray(tlsStellarTxRecords.finalityStatus, activeStatuses))
      .orderBy(tlsStellarTxRecords.updatedAt)
      .limit(config.batchSize) as TxRecord[];

    if (records.length === 0) {
      logger.debug({ currentLedger }, "reconciler_tick_empty_batch");
    } else {
      logger.info(
        { currentLedger, batchSize: records.length },
        "reconciler_tick_start",
      );
    }

    // 3. Process each record
    for (const record of records) {
      await processRecord(record, currentLedger, config, summary, stats);
      summary.processed++;
    }
  } catch (err) {
    logger.error({ err }, "reconciler_tick_error");
    stats.totalErrors++;
    summary.errors++;
  } finally {
    const durationMs = Date.now() - tickStart;
    stats.lastTickAt = new Date();
    stats.lastTickDurationMs = durationMs;
    stats.tickCount++;

    if (summary.processed > 0) {
      logger.info(
        {
          processed: summary.processed,
          confirmed: summary.confirmed,
          failed: summary.failed,
          expired: summary.expired,
          notFound: summary.notFound,
          repairsApplied: summary.repairsApplied,
          errors: summary.errors,
          durationMs,
        },
        "reconciler_tick_complete",
      );
    }
  }

  return summary;
}

// ─── Single-record processing ─────────────────────────────────────────────────

async function processRecord(
  record: TxRecord,
  currentLedger: number,
  config: ReconcilerConfig,
  summary: TickSummary,
  stats: ReconcilerStats,
): Promise<void> {
  try {
    // Poll Horizon only for PENDING records (CONFIRMING just needs ledger depth check)
    let pollResult = null;
    if (record.finalityStatus === "PENDING") {
      pollResult = await pollTransaction(record.txHash, config.horizonUrl);

      logger.debug(
        {
          txHash: record.txHash,
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          pollOutcome: pollResult.outcome,
          pollCount: record.pollCount,
        },
        "reconciler_poll_result",
      );
    }

    // Compute next state
    const now = new Date();
    const update = computeTransition(record, pollResult, currentLedger, config, now);

    if (!update) {
      // No change
      return;
    }

    // Validate the transition before writing
    if (update.finalityStatus && update.finalityStatus !== record.finalityStatus) {
      const err = validateTransition(record.finalityStatus, update.finalityStatus);
      if (err) {
        logger.error(
          { txHash: record.txHash, from: record.finalityStatus, to: update.finalityStatus, err },
          "reconciler_invalid_transition",
        );
        stats.totalErrors++;
        summary.errors++;
        return;
      }

      logger.info(
        {
          txHash: record.txHash,
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          from: record.finalityStatus,
          to: update.finalityStatus,
          currentLedger,
          confirmedLedger: update.confirmedLedger ?? record.confirmedLedger,
        },
        "reconciler_state_transition",
      );
    }

    // Persist the update
    await db
      .update(tlsStellarTxRecords)
      .set({
        finalityStatus: update.finalityStatus ?? record.finalityStatus,
        lastLedgerChecked: update.lastLedgerChecked ?? record.lastLedgerChecked,
        confirmedLedger: update.confirmedLedger ?? record.confirmedLedger,
        pollCount: update.pollCount ?? record.pollCount,
        lastError: update.lastError !== undefined ? update.lastError : record.lastError,
        updatedAt: update.updatedAt ?? now,
      })
      .where(eq(tlsStellarTxRecords.id, record.id));

    // Update summary counters
    const newStatus: FinalityStatus =
      (update.finalityStatus as FinalityStatus | undefined) ?? record.finalityStatus;

    switch (newStatus) {
      case "CONFIRMED":
        summary.confirmed++;
        stats.totalConfirmed++;
        break;
      case "FAILED":
        summary.failed++;
        stats.totalFailed++;
        break;
      case "EXPIRED":
        summary.expired++;
        stats.totalExpired++;
        break;
      case "NOT_FOUND":
        summary.notFound++;
        stats.totalNotFound++;
        break;
    }

    // Apply downstream repair if needed
    const updatedRecord: TxRecord = {
      ...record,
      ...(update.finalityStatus ? { finalityStatus: update.finalityStatus as FinalityStatus } : {}),
      ...(update.confirmedLedger !== undefined ? { confirmedLedger: update.confirmedLedger } : {}),
    };

    if (needsRepair(updatedRecord)) {
      const repairResult = await applyRepair(updatedRecord);

      if (repairResult.ok) {
        if (repairResult.repaired) {
          await db
            .update(tlsStellarTxRecords)
            .set({ repairApplied: true, updatedAt: new Date() })
            .where(eq(tlsStellarTxRecords.id, record.id));

          summary.repairsApplied++;
          stats.totalRepairsApplied++;

          logger.info(
            {
              txHash: record.txHash,
              sourceType: record.sourceType,
              sourceId: record.sourceId,
              detail: repairResult.detail,
            },
            "reconciler_repair_applied",
          );
        } else {
          // Mark repair_applied=true anyway so we don't keep re-attempting
          // a no-op (e.g. record already in correct state)
          await db
            .update(tlsStellarTxRecords)
            .set({ repairApplied: true, updatedAt: new Date() })
            .where(eq(tlsStellarTxRecords.id, record.id));

          logger.debug(
            {
              txHash: record.txHash,
              sourceType: record.sourceType,
              detail: repairResult.detail,
            },
            "reconciler_repair_noop",
          );
        }
      } else {
        logger.error(
          {
            txHash: record.txHash,
            sourceType: record.sourceType,
            sourceId: record.sourceId,
            error: repairResult.error,
          },
          "reconciler_repair_failed",
        );
        stats.totalErrors++;
        summary.errors++;
      }
    }
  } catch (err) {
    logger.error(
      { txHash: record.txHash, sourceType: record.sourceType, err },
      "reconciler_record_error",
    );
    stats.totalErrors++;
    summary.errors++;
  }
}

// ─── Registration helper ──────────────────────────────────────────────────────

/**
 * Register a new transaction hash for finality tracking.
 *
 * Idempotent: if the txHash already exists, returns the existing record id
 * without throwing.
 */
export async function registerTx(opts: {
  txHash: string;
  sourceType: "commerce_job" | "token_purchase" | "other";
  sourceId?: string;
  ledgerSubmitted?: number;
  /** If omitted, defaults to now + 1 hour */
  expiresAt?: Date;
}): Promise<string> {
  const { txHash, sourceType, sourceId, ledgerSubmitted } = opts;
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);

  // Check for existing record first (upsert not needed; conflict = idempotent)
  const existing = await db
    .select({ id: tlsStellarTxRecords.id })
    .from(tlsStellarTxRecords)
    .where(eq(tlsStellarTxRecords.txHash, txHash))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (existing) {
    return existing.id;
  }

  const id = createId();
  await db.insert(tlsStellarTxRecords).values({
    id,
    txHash,
    sourceType,
    sourceId: sourceId ?? null,
    finalityStatus: "PENDING",
    ledgerSubmitted: ledgerSubmitted ?? null,
    pollCount: 0,
    repairApplied: false,
    expiresAt,
  });

  logger.info(
    { txHash, sourceType, sourceId, id },
    "reconciler_tx_registered",
  );

  return id;
}

// ─── Tick summary type ────────────────────────────────────────────────────────

export interface TickSummary {
  processed: number;
  confirmed: number;
  failed: number;
  expired: number;
  notFound: number;
  repairsApplied: number;
  errors: number;
  currentLedger: number | null;
}
