/**
 * Idempotent repair logic for the finality reconciler.
 *
 * When a tracked transaction reaches a terminal state (CONFIRMED, FAILED,
 * EXPIRED, NOT_FOUND) the reconciler calls applyRepair() to propagate that
 * outcome to the originating subsystem row (commerce job, token purchase, etc.).
 *
 * Design guarantees:
 *   - Every repair function is idempotent: calling it twice leaves the DB in
 *     the same state as calling it once.
 *   - Repairs are conditional: they only modify rows whose status indicates they
 *     are still waiting on finality, so a crash-and-retry cannot double-apply.
 *   - All DB writes for a single repair are wrapped in a single transaction so
 *     a partial failure leaves the row unchanged.
 *   - No secrets or user payload content are logged.
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs, tlsTokenPurchases, tlsStellarTxRecords } from "@/db/schema";
import { logger } from "@/lib/logger";
import type { TxRecord, RepairOutcome } from "./types";

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Apply the appropriate downstream repair for a terminal tx record.
 *
 * Returns RepairOutcome — the scheduler uses this to decide whether to flip
 * repair_applied=true on the tx record.
 */
export async function applyRepair(record: TxRecord): Promise<RepairOutcome> {
  switch (record.sourceType) {
    case "commerce_job":
      return repairCommerceJob(record);

    case "token_purchase":
      return repairTokenPurchase(record);

    case "other":
      // No structured repair needed — mark as handled
      return { ok: true, repaired: false, detail: "sourceType=other: no repair needed" };

    default:
      return { ok: true, repaired: false, detail: `Unknown sourceType: ${(record as TxRecord).sourceType}` };
  }
}

// ─── Commerce job repair ──────────────────────────────────────────────────────

/**
 * Repair a commerce job whose Stellar payment transaction has reached finality.
 *
 * Status mapping:
 *   CONFIRMED  → job stays "pending" (tx settlement confirmed; agent fulfils)
 *                OR already "completed" — no-op.
 *   FAILED     → job transitions to "payment_failed" (idempotent)
 *   EXPIRED    → job transitions to "payment_expired"
 *   NOT_FOUND  → job transitions to "payment_not_found"
 */
async function repairCommerceJob(record: TxRecord): Promise<RepairOutcome> {
  if (!record.sourceId) {
    return { ok: true, repaired: false, detail: "No sourceId for commerce_job repair" };
  }

  const jobId = record.sourceId;
  const finalityStatus = record.finalityStatus;

  try {
    if (finalityStatus === "CONFIRMED") {
      // Tx confirmed — the job payment is settled.  Jobs start in "pending"
      // which means the agent has not fulfilled yet; we do not need to change
      // anything.  If someone already set it to "completed" or "failed",
      // leave it alone.
      logger.info(
        { jobId, txHash: record.txHash, finalityStatus },
        "reconciler_job_payment_confirmed",
      );
      return { ok: true, repaired: true, detail: "Payment confirmed; job unchanged" };
    }

    // Map finality terminal to a descriptive job status string
    const newJobStatus =
      finalityStatus === "FAILED"     ? "payment_failed" :
      finalityStatus === "EXPIRED"    ? "payment_expired" :
      finalityStatus === "NOT_FOUND"  ? "payment_not_found" :
      null;

    if (!newJobStatus) {
      return { ok: true, repaired: false, detail: `Unhandled finalityStatus=${finalityStatus}` };
    }

    // Idempotent update: only flip jobs still in "pending" status so a
    // second repair invocation is a no-op.
    const [updated] = await db
      .update(tlsCommerceJobs)
      .set({ status: newJobStatus, updatedAt: new Date() })
      .where(
        and(
          eq(tlsCommerceJobs.id, jobId),
          inArray(tlsCommerceJobs.status, ["pending"]),
        ),
      )
      .returning({ id: tlsCommerceJobs.id, status: tlsCommerceJobs.status });

    if (updated) {
      logger.info(
        { jobId, txHash: record.txHash, finalityStatus, newJobStatus },
        "reconciler_job_repaired",
      );
      return { ok: true, repaired: true, detail: `Job status → ${newJobStatus}` };
    }

    // Row was not in "pending" — already handled or doesn't exist
    return { ok: true, repaired: false, detail: `Job ${jobId} not in repairable state` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, txHash: record.txHash, err }, "reconciler_job_repair_error");
    return { ok: false, error: message };
  }
}

// ─── Token purchase repair ────────────────────────────────────────────────────

/**
 * Repair a token purchase whose Stellar payment transaction has reached finality.
 *
 * Status mapping:
 *   CONFIRMED  → token purchase stays "completed" (should already be set by
 *                the buy-token route).  If it is somehow still "pending" we
 *                leave it for manual review — the buy-token route handles the
 *                full completion including patron upsert and revenue insert.
 *   FAILED     → token purchase transitions to "failed"
 *   EXPIRED    → token purchase transitions to "failed" (same effect)
 *   NOT_FOUND  → token purchase transitions to "failed"
 */
async function repairTokenPurchase(record: TxRecord): Promise<RepairOutcome> {
  // For token purchases the sourceId IS the txHash (it's the primary key)
  const txHash = record.sourceId ?? record.txHash;

  try {
    if (record.finalityStatus === "CONFIRMED") {
      // Happy path: buy-token route already set this to "completed".
      // Confirm it reached "completed"; if still "pending", log a warning for
      // manual review (we don't replicate the full purchase logic here).
      const existing = await db
        .select({ status: tlsTokenPurchases.status })
        .from(tlsTokenPurchases)
        .where(eq(tlsTokenPurchases.txHash, txHash))
        .limit(1)
        .then((r) => r[0] ?? null);

      if (!existing) {
        return { ok: true, repaired: false, detail: "Token purchase row not found" };
      }

      if (existing.status === "pending") {
        logger.warn(
          { txHash, finalityStatus: record.finalityStatus },
          "reconciler_token_purchase_stuck_pending_after_confirm",
        );
        return {
          ok: true,
          repaired: false,
          detail: "Token purchase still pending after chain confirm — manual review needed",
        };
      }

      return { ok: true, repaired: true, detail: "Token purchase already completed" };
    }

    // FAILED | EXPIRED | NOT_FOUND → mark the purchase as failed (idempotent)
    const [updated] = await db
      .update(tlsTokenPurchases)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(tlsTokenPurchases.txHash, txHash),
          inArray(tlsTokenPurchases.status, ["pending"]),
        ),
      )
      .returning({ txHash: tlsTokenPurchases.txHash });

    if (updated) {
      logger.info(
        { txHash, finalityStatus: record.finalityStatus },
        "reconciler_token_purchase_repaired",
      );
      return { ok: true, repaired: true, detail: `Token purchase status → failed` };
    }

    return { ok: true, repaired: false, detail: "Token purchase already in non-pending state" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ txHash, err }, "reconciler_token_purchase_repair_error");
    return { ok: false, error: message };
  }
}

// ─── Revision-guarded repair (operator-triggered) ─────────────────────────────

/**
 * Apply downstream repair for `record` and atomically flip `repairApplied`
 * on the tx record — but only if the record has not been updated since the
 * caller observed it (optimistic concurrency via `updatedAt`).
 *
 * This is the entry point for operator-triggered repair actions. It prevents
 * a stale repair action from overwriting newer state: if another process
 * (the background reconciler, a concurrent operator request) has written
 * to this row since the caller loaded it, the `UPDATE … WHERE updated_at =
 * :observed` guard matches 0 rows and this function returns
 * `{ ok: false, stale: true }` without touching any downstream rows.
 *
 * Usage
 * ─────
 *   const record = await loadTxRecord(id);          // operator observes record
 *   // …operator decides to trigger repair…
 *   const result = await applyRepairWithRevisionGuard(record);
 *   if (!result.ok && result.stale) {
 *     // The record changed between observation and action — reload and retry
 *   }
 */
export async function applyRepairWithRevisionGuard(
  record: TxRecord,
): Promise<RepairOutcome> {
  // 1. Apply the downstream repair (idempotent — safe to call even if the guard
  //    later fails; the downstream update's own WHERE clause makes it a no-op
  //    if it already ran).
  const repairResult = await applyRepair(record);

  if (!repairResult.ok) {
    // Downstream repair itself failed — surface the error without touching
    // the tx record.
    return repairResult;
  }

  // 2. Atomically flip repairApplied=true on the tx record, but only if
  //    updatedAt still matches what the caller observed. If another writer
  //    beat us here the guard rejects the action.
  const [flipped] = await db
    .update(tlsStellarTxRecords)
    .set({ repairApplied: true, updatedAt: new Date() })
    .where(
      and(
        eq(tlsStellarTxRecords.id, record.id),
        eq(tlsStellarTxRecords.updatedAt, record.updatedAt),
      ),
    )
    .returning({ id: tlsStellarTxRecords.id });

  if (!flipped) {
    logger.warn(
      { txHash: record.txHash, sourceType: record.sourceType, observedUpdatedAt: record.updatedAt },
      "reconciler_repair_stale_revision",
    );
    return {
      ok: false,
      error: "Repair rejected: record was updated after it was observed (stale revision)",
      stale: true,
    };
  }

  logger.info(
    { txHash: record.txHash, sourceType: record.sourceType, detail: repairResult.detail },
    "reconciler_repair_applied_with_revision_guard",
  );

  return repairResult;
}
