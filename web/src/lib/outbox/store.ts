import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsOutboxEvents } from "@/db/schema";
import type { OutboxEvent, OutboxStatus, WriteEventInput } from "./types";
import { decideRetry } from "./retry";
import { outboxConfig } from "./config";
import { logOutboxEvent, truncateError } from "./metrics";

/** Same shape as `db`, scoped to one transaction — see db.transaction()'s callback param. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toEvent(row: typeof tlsOutboxEvents.$inferSelect): OutboxEvent {
  return row as unknown as OutboxEvent;
}

/**
 * Atomic outbox write. Pass the same `tx` you're using for the domain
 * mutation this event describes — e.g.:
 *
 *   await db.transaction(async (tx) => {
 *     const [job] = await tx.update(tlsCommerceJobs)...returning();
 *     await writeOutboxEvent(tx, { aggregateType: "commerce_job", aggregateId: job.id, eventType: "commerce_job.completed", payload: {...} });
 *   });
 *
 * so the event can never be written without the mutation committing (or
 * vice versa) — the two either both land or both roll back.
 *
 * Idempotent when `dedupeKey` is supplied: a repeat write with the same
 * (eventType, dedupeKey) is a no-op, returning the existing row.
 */
export async function writeOutboxEvent<TPayload = unknown>(
  tx: Tx,
  input: WriteEventInput<TPayload>,
): Promise<OutboxEvent<TPayload>> {
  if (input.dedupeKey) {
    const existing = await tx
      .select()
      .from(tlsOutboxEvents)
      .where(and(eq(tlsOutboxEvents.eventType, input.eventType), eq(tlsOutboxEvents.dedupeKey, input.dedupeKey)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existing) return toEvent(existing) as OutboxEvent<TPayload>;
  }

  const [row] = await tx
    .insert(tlsOutboxEvents)
    .values({
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      maxAttempts: input.maxAttempts ?? outboxConfig.defaultMaxAttempts,
      dedupeKey: input.dedupeKey ?? null,
    })
    .returning();

  logOutboxEvent("outbox_event_written", { eventId: row.id, eventType: row.eventType, aggregateType: row.aggregateType });
  return toEvent(row) as OutboxEvent<TPayload>;
}

/**
 * Atomically claims up to `limit` due events, marking them leased.
 * `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent dispatchers (multiple
 * instances, or an overlapping scheduler tick) never claim the same row.
 */
export async function leaseBatch(
  limit: number = outboxConfig.batchSize,
  workerId: string = outboxConfig.workerId,
  leaseDurationMs: number = outboxConfig.leaseDurationMs,
): Promise<OutboxEvent[]> {
  if (limit <= 0) return [];

  const leaseExpiresAt = sql`now() + (${leaseDurationMs}::text || ' milliseconds')::interval`;
  const result = await db.execute(sql`
    UPDATE ${tlsOutboxEvents}
    SET
      status = 'leased',
      "leaseId" = gen_random_uuid()::text,
      "leaseOwner" = ${workerId},
      "leaseExpiresAt" = ${leaseExpiresAt},
      attempts = attempts + 1,
      "updatedAt" = now()
    WHERE id IN (
      SELECT id FROM ${tlsOutboxEvents}
      WHERE status = 'pending'
        AND "runAt" <= now()
      ORDER BY "runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING *
  `);

  const rows = (result as unknown as { rows: (typeof tlsOutboxEvents.$inferSelect)[] }).rows ?? [];
  for (const row of rows) {
    logOutboxEvent("outbox_event_leased", { eventId: row.id, eventType: row.eventType, attempts: row.attempts, workerId });
  }
  return rows.map(toEvent);
}

/** Marks a leased event dispatched. No-ops (returns null) if the lease was lost. */
export async function ack(eventId: string, leaseId: string): Promise<OutboxEvent | null> {
  const [row] = await db
    .update(tlsOutboxEvents)
    .set({ status: "dispatched", dispatchedAt: sql`now()`, leaseId: null, leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(tlsOutboxEvents.id, eventId), eq(tlsOutboxEvents.leaseId, leaseId), eq(tlsOutboxEvents.status, "leased")))
    .returning();
  if (!row) return null;
  logOutboxEvent("outbox_event_dispatched", { eventId, eventType: row.eventType, attempts: row.attempts });
  return toEvent(row);
}

/** Records a consumer failure and either reschedules (pending) or dead-letters. No-ops if the lease was lost. */
export async function fail(eventId: string, leaseId: string, error: unknown): Promise<OutboxEvent | null> {
  const current = await db
    .select()
    .from(tlsOutboxEvents)
    .where(and(eq(tlsOutboxEvents.id, eventId), eq(tlsOutboxEvents.leaseId, leaseId), eq(tlsOutboxEvents.status, "leased")))
    .limit(1)
    .then((r) => r[0] ?? null);
  if (!current) return null;

  const lastError = truncateError(error);
  const decision = decideRetry({ attempts: current.attempts, maxAttempts: current.maxAttempts });

  if (decision.action === "dead_letter") {
    const [row] = await db
      .update(tlsOutboxEvents)
      .set({ status: "dead_letter", lastError, leaseId: null, leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(tlsOutboxEvents.id, eventId), eq(tlsOutboxEvents.leaseId, leaseId), eq(tlsOutboxEvents.status, "leased")))
      .returning();
    if (!row) return null;
    logOutboxEvent("outbox_event_dead_letter", { eventId, eventType: row.eventType, attempts: row.attempts, maxAttempts: row.maxAttempts });
    return toEvent(row);
  }

  const runAt = new Date(Date.now() + decision.delayMs);
  const [row] = await db
    .update(tlsOutboxEvents)
    .set({ status: "pending", runAt, lastError, leaseId: null, leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(tlsOutboxEvents.id, eventId), eq(tlsOutboxEvents.leaseId, leaseId), eq(tlsOutboxEvents.status, "leased")))
    .returning();
  if (!row) return null;
  logOutboxEvent("outbox_event_retry_scheduled", { eventId, eventType: row.eventType, attempts: row.attempts, delayMs: decision.delayMs });
  return toEvent(row);
}

/** Admin action: requeue a dead_letter event (resets attempts, clears lastError, runAt = now). */
export async function requeue(eventId: string): Promise<OutboxEvent | null> {
  const [row] = await db
    .update(tlsOutboxEvents)
    .set({ status: "pending", attempts: 0, lastError: null, runAt: sql`now()` })
    .where(and(eq(tlsOutboxEvents.id, eventId), eq(tlsOutboxEvents.status, "dead_letter")))
    .returning();
  return row ? toEvent(row) : null;
}

/**
 * Recovers events whose dispatcher died mid-lease. No separate
 * crash-recovery path exists beyond this — it's what makes leasing safe
 * across multiple instances. Call on every dispatchOnce().
 */
export async function reapExpiredLeases(): Promise<{ requeued: number; deadLettered: number }> {
  const requeuedRows = await db
    .update(tlsOutboxEvents)
    .set({ status: "pending", leaseId: null, leaseOwner: null, leaseExpiresAt: null, lastError: "lease expired (dispatcher died mid-lease)" })
    .where(
      and(
        eq(tlsOutboxEvents.status, "leased"),
        isNotNull(tlsOutboxEvents.leaseExpiresAt),
        lt(tlsOutboxEvents.leaseExpiresAt, sql`now()`),
        sql`${tlsOutboxEvents.attempts} < ${tlsOutboxEvents.maxAttempts}`,
      ),
    )
    .returning({ id: tlsOutboxEvents.id, eventType: tlsOutboxEvents.eventType });

  const deadLetteredRows = await db
    .update(tlsOutboxEvents)
    .set({ status: "dead_letter", leaseId: null, leaseOwner: null, leaseExpiresAt: null, lastError: "lease expired and max attempts reached" })
    .where(
      and(
        eq(tlsOutboxEvents.status, "leased"),
        isNotNull(tlsOutboxEvents.leaseExpiresAt),
        lt(tlsOutboxEvents.leaseExpiresAt, sql`now()`),
        sql`${tlsOutboxEvents.attempts} >= ${tlsOutboxEvents.maxAttempts}`,
      ),
    )
    .returning({ id: tlsOutboxEvents.id, eventType: tlsOutboxEvents.eventType });

  for (const row of requeuedRows) logOutboxEvent("outbox_lease_reaped", { eventId: row.id, eventType: row.eventType });
  for (const row of deadLetteredRows) logOutboxEvent("outbox_event_dead_letter", { eventId: row.id, eventType: row.eventType });

  return { requeued: requeuedRows.length, deadLettered: deadLetteredRows.length };
}

/** Retention: deletes dispatched events older than `retentionDays`. Dead-lettered events are kept (need operator attention). */
export async function pruneDispatched(retentionDays: number = outboxConfig.retentionDays): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(tlsOutboxEvents)
    .where(and(eq(tlsOutboxEvents.status, "dispatched"), lt(tlsOutboxEvents.dispatchedAt, cutoff)))
    .returning({ id: tlsOutboxEvents.id });
  if (rows.length > 0) logOutboxEvent("outbox_events_pruned", { count: rows.length, retentionDays });
  return rows.length;
}

// ─── Admin inspection ──────────────────────────────────────────────

export interface ListEventsFilter {
  status?: OutboxStatus;
  eventType?: string;
  cursor?: string;
  limit?: number;
}

export async function listEvents(filter: ListEventsFilter = {}): Promise<{ events: OutboxEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const conditions = [];
  if (filter.status) conditions.push(eq(tlsOutboxEvents.status, filter.status));
  if (filter.eventType) conditions.push(eq(tlsOutboxEvents.eventType, filter.eventType));
  if (filter.cursor) conditions.push(lt(tlsOutboxEvents.createdAt, new Date(filter.cursor)));

  const rows = await db
    .select()
    .from(tlsOutboxEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tlsOutboxEvents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;
  return { events: page.map(toEvent), nextCursor };
}

export async function getEvent(eventId: string): Promise<OutboxEvent | null> {
  const row = await db.select().from(tlsOutboxEvents).where(eq(tlsOutboxEvents.id, eventId)).limit(1).then((r) => r[0] ?? null);
  return row ? toEvent(row) : null;
}
