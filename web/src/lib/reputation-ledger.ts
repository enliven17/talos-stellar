import { db } from "@/db";
import { tlsCommerceJobs, tlsReputationInputs } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

// Terminal statuses that should be recorded in the ledger
export const TERMINAL_JOB_STATUSES = [
  "completed",
  "accepted",
  "fulfilled",
  "settled",
  "failed",
  "rejected",
  "cancelled",
  "disputed",
  "refunded",
];

// Reusable type for a generic Drizzle postgres transaction
export type DbTx = PgTransaction<
  PostgresJsQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * Idempotently ingests a terminal job into the reputation input ledger.
 * This preserves provenance (txHash, status, counterparties, etc.)
 * without leaking private job payloads or results.
 */
export async function ingestJobToLedger(jobId: string, tx?: any) {
  const dbOrTx = tx ?? db;

  const jobRows = await dbOrTx
    .select()
    .from(tlsCommerceJobs)
    .where(eq(tlsCommerceJobs.id, jobId))
    .limit(1);

  const job = jobRows[0] ?? null;

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (!TERMINAL_JOB_STATUSES.includes(job.status)) {
    // We only record settled/terminal outcomes
    return null;
  }

  // Extract signals while avoiding storing the whole payload/result
  const payloadStr = job.payload ? JSON.stringify(job.payload) : "{}";
  const resultStr = job.result ? JSON.stringify(job.result) : "{}";
  
  const payloadObj = typeof job.payload === "object" && job.payload !== null ? job.payload : {};
  const resultObj = typeof job.result === "object" && job.result !== null ? job.result : {};

  const hasResult = Object.keys(resultObj).length > 0;
  
  // Extract authoritative signals from the payload/result
  // The exact keys depend on the service contract, but we look for common ones:
  const rawDeadline = payloadObj.deadlineAt || payloadObj.deadline;
  const deadlineAt = rawDeadline ? new Date(rawDeadline) : null;
  
  // E.g. { refundAmount: "50.00" } or { refund: { amount: "50.00" } }
  const refundAmount = resultObj.refundAmount?.toString() || null;

  const [inserted] = await dbOrTx
    .insert(tlsReputationInputs)
    .values({
      talosId: job.talosId,
      jobId: job.id,
      requesterTalosId: job.requesterTalosId,
      status: job.status,
      jobCreatedAt: job.createdAt,
      jobUpdatedAt: job.updatedAt,
      deadlineAt,
      refundAmount,
      hasResult,
      txHash: job.txHash,
    })
    .onConflictDoUpdate({
      target: tlsReputationInputs.jobId,
      set: {
        status: job.status,
        jobUpdatedAt: job.updatedAt,
        deadlineAt,
        refundAmount,
        hasResult,
        txHash: job.txHash,
        updatedAt: new Date(),
      },
    })
    .returning();

  return inserted;
}

/**
 * Sweeps all existing commerce jobs for a provider (or all providers)
 * and rebuilds the reputation ledger. Useful for migrations or
 * retroactive state corrections.
 */
export async function rebuildReputationLedger(providerId?: string) {
  let query = db.select().from(tlsCommerceJobs);

  if (providerId) {
    query = query.where(eq(tlsCommerceJobs.talosId, providerId)) as any;
  }

  const jobs = await query;
  const terminalJobs = jobs.filter((j: any) =>
    TERMINAL_JOB_STATUSES.includes(j.status)
  );

  let ingestedCount = 0;
  // Note: For massive scale, this should use a batch insert.
  // We use sequential ingestion here to reuse the idempotency logic
  // and handle potential concurrent modifications safely.
  for (const job of terminalJobs) {
    await ingestJobToLedger(job.id);
    ingestedCount++;
  }

  return { ingestedCount };
}
