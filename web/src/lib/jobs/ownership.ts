import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsJobs } from "@/db/schema";
import type { JobRecord } from "./types";

export interface OwnershipReport {
  /** Jobs in 'leased' state with inconsistent lease fields. */
  incompatibleLeases: JobRecord[];
  /** Jobs with no reap path: leased+no expiry, or attempts exceeding maxAttempts. */
  orphanedAttempts: JobRecord[];
  /** When the check ran. */
  checkedAt: Date;
}

function toRecord(row: typeof tlsJobs.$inferSelect): JobRecord {
  return row as unknown as JobRecord;
}

/**
 * Scans the jobs table for ownership inconsistencies and returns a read-only
 * report. Never writes to the database; any repair must be triggered
 * separately.
 *
 * Incompatible leases: rows in 'leased' state where leaseId, leaseOwner,
 * or leaseExpiresAt is NULL — these cannot be heartbeated or reaped through
 * the normal path.
 *
 * Orphaned attempts: rows with no reap path (leased with no leaseExpiresAt)
 * or where the attempts counter has exceeded the maxAttempts ceiling.
 */
export async function checkOwnership(): Promise<OwnershipReport> {
  const checkedAt = new Date();

  // Incompatible leases: leased jobs missing one or more lease fields
  const incompatibleRows = await db
    .select()
    .from(tlsJobs)
    .where(
      and(
        eq(tlsJobs.status, "leased"),
        or(
          isNull(tlsJobs.leaseId),
          isNull(tlsJobs.leaseOwner),
          isNull(tlsJobs.leaseExpiresAt),
        ),
      ),
    );

  // Orphaned attempts: leased with no expiry (can never be reaped) OR
  // attempts has exceeded maxAttempts (should have been dead-lettered)
  const orphanedRows = await db
    .select()
    .from(tlsJobs)
    .where(
      or(
        and(eq(tlsJobs.status, "leased"), isNull(tlsJobs.leaseExpiresAt)),
        sql`${tlsJobs.attempts} > ${tlsJobs.maxAttempts}`,
      ),
    );

  return {
    incompatibleLeases: incompatibleRows.map(toRecord),
    orphanedAttempts: orphanedRows.map(toRecord),
    checkedAt,
  };
}
