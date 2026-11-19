import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsJobs } from "@/db/schema";
import type { EnqueueOptions, JobRecord, JobStatus, RetryClass } from "./types";
import { decideRetry } from "./retry";
import { jobsConfig } from "./config";
import { logJobEvent, truncateError } from "./metrics";

function toRecord(row: typeof tlsJobs.$inferSelect): JobRecord {
  return row as unknown as JobRecord;
}

/**
 * Enqueue a job. Idempotent when `idempotencyKey` is supplied: a repeat
 * enqueue with the same (queue, idempotencyKey) is a no-op that returns the
 * existing row rather than erroring, so callers on an at-least-once delivery
 * path (e.g. a webhook retry) don't create duplicate work.
 */
export async function enqueue<TPayload = unknown>(
  queue: string,
  payload: TPayload,
  opts: EnqueueOptions = {},
): Promise<JobRecord<TPayload>> {
  const runAt = new Date(Date.now() + (opts.delayMs ?? 0));

  if (opts.idempotencyKey) {
    const existing = await db
      .select()
      .from(tlsJobs)
      .where(and(eq(tlsJobs.queue, queue), eq(tlsJobs.idempotencyKey, opts.idempotencyKey)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existing) return toRecord(existing) as JobRecord<TPayload>;
  }

  const [row] = await db
    .insert(tlsJobs)
    .values({
      queue,
      payload: (payload ?? {}) as Record<string, unknown>,
      runAt,
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? jobsConfig.defaultMaxAttempts,
      retryClass: opts.retryClass ?? "transient",
      idempotencyKey: opts.idempotencyKey ?? null,
    })
    .returning();

  logJobEvent("job_enqueued", { jobId: row.id, queue });
  return toRecord(row) as JobRecord<TPayload>;
}

/**
 * Atomically claims up to `limit` due jobs for `queues` and marks them
 * leased. Uses `FOR UPDATE SKIP LOCKED` so concurrent callers (multiple
 * instances draining the same table) never claim the same row — this is
 * the only query in the module that needs raw SQL, since drizzle's query
 * builder doesn't expose SKIP LOCKED.
 */
export async function leaseBatch(
  queues: string[],
  limit: number = jobsConfig.batchSize,
  workerId: string = jobsConfig.workerId,
  leaseDurationMs: number = jobsConfig.leaseDurationMs,
): Promise<JobRecord[]> {
  if (queues.length === 0 || limit <= 0) return [];

  const leaseExpiresAt = sql`now() + (${leaseDurationMs}::text || ' milliseconds')::interval`;
  const result = await db.execute(sql`
    UPDATE ${tlsJobs}
    SET
      status = 'leased',
      "leaseId" = gen_random_uuid()::text,
      "leaseOwner" = ${workerId},
      "leaseExpiresAt" = ${leaseExpiresAt},
      "heartbeatAt" = now(),
      attempts = attempts + 1,
      "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM ${tlsJobs}
      WHERE status = 'pending'
        AND ${inArray(tlsJobs.queue, queues)}
        AND "runAt" <= now()
      ORDER BY priority DESC, "runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);

  const rows = (result as unknown as { rows: (typeof tlsJobs.$inferSelect)[] }).rows ?? [];
  for (const row of rows) {
    logJobEvent("job_leased", { jobId: row.id, queue: row.queue, attempts: row.attempts, workerId });
  }
  return rows.map(toRecord);
}

/**
 * Extends a held lease and reports cooperative-cancellation state. Returns
 * `ok: false` when the lease no longer belongs to this worker (already
 * completed, reaped and re-leased elsewhere, etc.) — the caller must stop
 * processing immediately to avoid duplicate side effects racing another
 * worker.
 */
export async function heartbeat(
  jobId: string,
  leaseId: string,
  leaseDurationMs: number = jobsConfig.leaseDurationMs,
): Promise<{ ok: boolean; cancelled: boolean }> {
  const leaseExpiresAt = sql`now() + (${leaseDurationMs}::text || ' milliseconds')::interval`;
  const [row] = await db
    .update(tlsJobs)
    .set({ leaseExpiresAt, heartbeatAt: sql`now()` })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
    .returning({ cancelRequested: tlsJobs.cancelRequested, queue: tlsJobs.queue });

  if (!row) return { ok: false, cancelled: false };
  logJobEvent("job_heartbeat", { jobId, queue: row.queue });
  return { ok: true, cancelled: row.cancelRequested };
}

/** Marks a leased job completed. No-ops (returns null) if the lease was lost. */
export async function complete(jobId: string, leaseId: string, result: unknown, durationMs?: number): Promise<JobRecord | null> {
  const [row] = await db
    .update(tlsJobs)
    .set({
      status: "completed",
      result: (result ?? null) as Record<string, unknown> | null,
      completedAt: sql`now()`,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
    .returning();

  if (!row) return null;
  logJobEvent("job_completed", { jobId, queue: row.queue, attempts: row.attempts, durationMs });
  return toRecord(row);
}

/**
 * Records a handler failure and applies the retry policy: either reschedule
 * (status back to pending, runAt pushed out by the backoff delay) or move
 * to dead_letter once the retry class/attempt ceiling says to stop.
 * No-ops if the lease was lost.
 */
export async function fail(jobId: string, leaseId: string, error: unknown, durationMs?: number): Promise<JobRecord | null> {
  const current = await db
    .select()
    .from(tlsJobs)
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!current) return null;

  const lastError = truncateError(error);
  const decision = decideRetry({
    retryClass: current.retryClass as RetryClass,
    attempts: current.attempts,
    maxAttempts: current.maxAttempts,
  });

  if (decision.action === "dead_letter") {
    const [row] = await db
      .update(tlsJobs)
      .set({ status: "dead_letter", lastError, leaseId: null, leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
      .returning();
    if (!row) return null;
    logJobEvent("job_dead_letter", { jobId, queue: row.queue, attempts: row.attempts, maxAttempts: row.maxAttempts, durationMs });
    return toRecord(row);
  }

  const runAt = new Date(Date.now() + decision.delayMs);
  const [row] = await db
    .update(tlsJobs)
    .set({ status: "pending", runAt, lastError, leaseId: null, leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
    .returning();
  if (!row) return null;
  logJobEvent("job_retry_scheduled", { jobId, queue: row.queue, attempts: row.attempts, delayMs: decision.delayMs, durationMs });
  return toRecord(row);
}

/**
 * Releases a lease back to pending without consuming a retry attempt or
 * recording an error. Used by graceful shutdown to return in-flight jobs to
 * the pool immediately instead of waiting out the full lease timeout.
 */
export async function release(jobId: string, leaseId: string): Promise<JobRecord | null> {
  const [row] = await db
    .update(tlsJobs)
    .set({ status: "pending", leaseId: null, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.leaseId, leaseId), eq(tlsJobs.status, "leased")))
    .returning();
  return row ? toRecord(row) : null;
}

/**
 * Requests cooperative cancellation. A pending job is cancelled immediately
 * (nothing is running yet); a leased job is flagged and relies on the
 * handler observing `cancelRequested` via its next heartbeat() call.
 */
export async function requestCancel(jobId: string): Promise<JobRecord | null> {
  const [pendingRow] = await db
    .update(tlsJobs)
    .set({ status: "cancelled", cancelRequested: true })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.status, "pending")))
    .returning();
  if (pendingRow) {
    logJobEvent("job_cancelled", { jobId, queue: pendingRow.queue });
    return toRecord(pendingRow);
  }

  const [leasedRow] = await db
    .update(tlsJobs)
    .set({ cancelRequested: true })
    .where(and(eq(tlsJobs.id, jobId), eq(tlsJobs.status, "leased")))
    .returning();
  return leasedRow ? toRecord(leasedRow) : null;
}

/**
 * Requeues a dead_letter (or cancelled) job for another attempt: resets
 * attempts/lastError and clears runAt back to now. Used by the admin
 * "retry" action.
 */
export async function requeue(jobId: string): Promise<JobRecord | null> {
  const [row] = await db
    .update(tlsJobs)
    .set({
      status: "pending",
      attempts: 0,
      lastError: null,
      cancelRequested: false,
      runAt: sql`now()`,
    })
    .where(and(eq(tlsJobs.id, jobId), sql`${tlsJobs.status} IN ('dead_letter', 'cancelled')`))
    .returning();
  return row ? toRecord(row) : null;
}

/**
 * Recovers jobs whose worker died mid-lease (process crash, OOM kill,
 * network partition) — the lease simply expired without a heartbeat.
 * Jobs with attempts remaining go back to pending; jobs that already
 * exhausted their retry budget go straight to dead_letter. Call this
 * periodically (runOnce() does it on every batch) — no other crash-recovery
 * path exists, which is what makes leasing safe across multiple instances.
 */
export async function reapExpiredLeases(): Promise<{ requeued: number; deadLettered: number }> {
  const requeuedRows = await db
    .update(tlsJobs)
    .set({ status: "pending", leaseId: null, leaseOwner: null, leaseExpiresAt: null, lastError: "lease expired (worker did not heartbeat)" })
    .where(
      and(
        eq(tlsJobs.status, "leased"),
        isNotNull(tlsJobs.leaseExpiresAt),
        lt(tlsJobs.leaseExpiresAt, sql`now()`),
        sql`${tlsJobs.attempts} < ${tlsJobs.maxAttempts}`,
      ),
    )
    .returning({ id: tlsJobs.id, queue: tlsJobs.queue });

  const deadLetteredRows = await db
    .update(tlsJobs)
    .set({
      status: "dead_letter",
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: "lease expired and max attempts reached (worker did not heartbeat)",
    })
    .where(
      and(
        eq(tlsJobs.status, "leased"),
        isNotNull(tlsJobs.leaseExpiresAt),
        lt(tlsJobs.leaseExpiresAt, sql`now()`),
        sql`${tlsJobs.attempts} >= ${tlsJobs.maxAttempts}`,
      ),
    )
    .returning({ id: tlsJobs.id, queue: tlsJobs.queue });

  for (const row of requeuedRows) logJobEvent("job_lease_reaped", { jobId: row.id, queue: row.queue });
  for (const row of deadLetteredRows) logJobEvent("job_dead_letter", { jobId: row.id, queue: row.queue });

  return { requeued: requeuedRows.length, deadLettered: deadLetteredRows.length };
}

// ─── Admin inspection ──────────────────────────────────────────────

export interface ListJobsFilter {
  status?: JobStatus;
  queue?: string;
  cursor?: string; // ISO timestamp, exclusive, paginating by createdAt desc
  limit?: number;
}

export async function listJobs(filter: ListJobsFilter = {}): Promise<{ jobs: JobRecord[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const conditions = [];
  if (filter.status) conditions.push(eq(tlsJobs.status, filter.status));
  if (filter.queue) conditions.push(eq(tlsJobs.queue, filter.queue));
  if (filter.cursor) conditions.push(lt(tlsJobs.createdAt, new Date(filter.cursor)));

  const rows = await db
    .select()
    .from(tlsJobs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tlsJobs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;
  return { jobs: page.map(toRecord), nextCursor };
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const row = await db.select().from(tlsJobs).where(eq(tlsJobs.id, jobId)).limit(1).then((r) => r[0] ?? null);
  return row ? toRecord(row) : null;
}
