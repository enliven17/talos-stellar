import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsCommerceJobs } from "@/db/schema";
import { idempotencyConfig, resolveCleanupBatchSize } from "./config";

/**
 * Bounded cleanup for completed commerce-job idempotency records.
 *
 * Retention model (deliberately derived, not stored):
 *   A record's idempotency key expires `IDEMPOTENCY_KEY_RETENTION_MS` after
 *   the record reached its terminal "completed" state. A terminal row is never
 *   written again, so its `updatedAt` *is* its completion time; deriving the
 *   expiry from it avoids adding a second, parallel source of truth for
 *   completion time (see docs/idempotency-design.md). `createdAt` is the
 *   fallback base if `updatedAt` is somehow absent.
 *
 * Safety properties:
 *   - Only rows with status = 'completed' AND a non-null idempotency key are
 *     candidates. Pending / negotiating / counter_offer rows are never read as
 *     candidates and never deleted.
 *   - Each run is bounded twice: the candidate SELECT fetches at most
 *     `limit + 1` rows, and the DELETE targets at most `limit` ids (clamped to
 *     IDEMPOTENCY_CLEANUP_MAX_BATCH).
 *   - Re-running is idempotent: once a run removes the expired rows, the next
 *     run finds nothing and deletes nothing.
 *   - A malformed or absent completion timestamp fails closed — the row is
 *     treated as non-expiring and is left untouched.
 *   - Missing table / column and other dependency failures are reported as a
 *     structured code, never as a thrown error or a partial state.
 */

/** Only records in this terminal state are ever eligible for key expiry. */
export const COMPLETED_JOB_STATUS = "completed";

/** The subset of a commerce-job row the expiry helpers need. */
export interface ExpiringIdempotencyRecord {
  id: string;
  status: string;
  idempotencyKey: string | null;
  updatedAt: Date | null;
  createdAt: Date | null;
}

export type IdempotencyCleanupFailureCode =
  | "invalid_options"
  | "table_missing"
  | "column_missing"
  | "dependency_failure";

export interface IdempotencyCleanupResult {
  ok: boolean;
  /** Rows actually removed by this run. */
  deleted: number;
  /** Candidate rows fetched from the database (at most limit + 1). */
  examined: number;
  /** Candidates that matched the SQL filter but failed the in-process guard. */
  skipped: number;
  /** True when the batch cap was hit and more expired rows may remain. */
  hasMore: boolean;
  /** Effective per-run row cap used for this run. */
  limit: number;
  /** Present only when ok is false. */
  code?: IdempotencyCleanupFailureCode;
}

export interface IdempotencyCleanupOptions {
  /** Max rows to delete in this run, clamped to [1, MAX_BATCH]. */
  limit?: number;
  /** Retention window in ms; defaults to idempotencyConfig.retentionMs. */
  retentionMs?: number;
  /** Clock injection for tests. Defaults to now. */
  now?: Date;
}

/**
 * Expiry instant for a completed record, or null when the key can never
 * expire (absent or malformed completion timestamp — fail closed).
 */
export function computeIdempotencyExpiry(
  completedAt: Date | null | undefined,
  retentionMs: number = idempotencyConfig.retentionMs,
): Date | null {
  if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) return null;

  const effectiveRetention =
    typeof retentionMs === "number" && Number.isFinite(retentionMs) && retentionMs >= 0
      ? retentionMs
      : idempotencyConfig.retentionMs;

  const expiresAt = new Date(completedAt.getTime() + effectiveRetention);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

/** Derives the expiry instant for a record from its terminal timestamp. */
export function resolveIdempotencyExpiresAt(
  record: Pick<ExpiringIdempotencyRecord, "updatedAt" | "createdAt">,
  retentionMs: number = idempotencyConfig.retentionMs,
): Date | null {
  return computeIdempotencyExpiry(record.updatedAt ?? record.createdAt ?? null, retentionMs);
}

/**
 * True only for a completed, keyed record whose retention window has elapsed.
 *
 * The boundary is inclusive: a key exactly at its expiry instant is already
 * expired. In-flight records (any status other than "completed") and records
 * without a key are never eligible, regardless of age.
 */
export function isExpiredCompletedIdempotencyKey(
  record: ExpiringIdempotencyRecord,
  now: Date,
  retentionMs: number = idempotencyConfig.retentionMs,
): boolean {
  if (record.status !== COMPLETED_JOB_STATUS) return false;
  if (!record.idempotencyKey) return false;

  const expiresAt = resolveIdempotencyExpiresAt(record, retentionMs);
  if (expiresAt === null) return false;

  return expiresAt.getTime() <= now.getTime();
}

export interface ExpiredIdempotencySelection {
  toDelete: string[];
  skipped: number;
  hasMore: boolean;
}

/**
 * Applies the in-process guard to a bounded page of database candidates and
 * returns the ids safe to delete.
 *
 * The SQL WHERE clause is the first line of defence; this is the second — a
 * row may have changed between the SELECT and the DELETE, or carry a
 * malformed/absent timestamp. Pure so it can be tested without a database.
 */
export function selectExpiredIdempotencyIds(
  candidates: ExpiringIdempotencyRecord[],
  now: Date,
  retentionMs: number,
  limit: number,
): ExpiredIdempotencySelection {
  const eligible = candidates.filter((row) =>
    isExpiredCompletedIdempotencyKey(row, now, retentionMs),
  );

  return {
    toDelete: eligible.slice(0, limit).map((row) => row.id),
    skipped: candidates.length - eligible.length,
    hasMore: candidates.length > limit,
  };
}

function classifyFailure(err: unknown): IdempotencyCleanupFailureCode {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (code === "42P01") return "table_missing";
  if (code === "42703") return "column_missing";
  return "dependency_failure";
}

function failure(
  code: IdempotencyCleanupFailureCode,
  limit: number,
): IdempotencyCleanupResult {
  return { ok: false, deleted: 0, examined: 0, skipped: 0, hasMore: false, limit, code };
}

/**
 * Deletes one bounded batch of expired, completed idempotency records.
 *
 * Never throws for database/configuration problems — inspect `ok` and `code`
 * instead. Idempotent: safe to re-run, and a run with nothing to delete is a
 * cheap no-op SELECT.
 */
export async function cleanupExpiredIdempotencyKeys(
  options: IdempotencyCleanupOptions = {},
): Promise<IdempotencyCleanupResult> {
  const limit = resolveCleanupBatchSize(options.limit);
  const now = options.now ?? new Date();

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return failure("invalid_options", limit);
  }

  const retentionMs =
    typeof options.retentionMs === "number" &&
    Number.isFinite(options.retentionMs) &&
    options.retentionMs >= 0
      ? options.retentionMs
      : idempotencyConfig.retentionMs;

  try {
    // Derived expiry as SQL, so the filter runs in the database and can use
    // the status index. Rows without a usable timestamp sort as NULL and are
    // excluded by the comparison, matching the in-process fail-closed guard.
    const expiry = sql`COALESCE(${tlsCommerceJobs.updatedAt}, ${tlsCommerceJobs.createdAt}) + (${retentionMs}::text || ' milliseconds')::interval`;

    const candidates = (await db
      .select({
        id: tlsCommerceJobs.id,
        status: tlsCommerceJobs.status,
        idempotencyKey: tlsCommerceJobs.idempotencyKey,
        updatedAt: tlsCommerceJobs.updatedAt,
        createdAt: tlsCommerceJobs.createdAt,
      })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.status, COMPLETED_JOB_STATUS),
          isNotNull(tlsCommerceJobs.idempotencyKey),
          sql`${expiry} <= ${now}`,
        ),
      )
      .orderBy(sql`${expiry} asc`)
      .limit(limit + 1)) as ExpiringIdempotencyRecord[];

    const { toDelete, skipped, hasMore } = selectExpiredIdempotencyIds(
      candidates,
      now,
      retentionMs,
      limit,
    );

    if (toDelete.length === 0) {
      return { ok: true, deleted: 0, examined: candidates.length, skipped, hasMore, limit };
    }

    // Re-assert the eligibility predicate on the DELETE so a row that changed
    // between SELECT and DELETE can never be removed. Bounded by `limit` ids.
    const removed = await db
      .delete(tlsCommerceJobs)
      .where(
        and(
          inArray(tlsCommerceJobs.id, toDelete),
          eq(tlsCommerceJobs.status, COMPLETED_JOB_STATUS),
          isNotNull(tlsCommerceJobs.idempotencyKey),
        ),
      )
      .returning({ id: tlsCommerceJobs.id });

    return {
      ok: true,
      deleted: removed.length,
      examined: candidates.length,
      skipped,
      hasMore,
      limit,
    };
  } catch (err) {
    return failure(classifyFailure(err), limit);
  }
}
