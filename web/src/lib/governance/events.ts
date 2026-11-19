/**
 * Canonical lifecycle events.
 *
 * These are the off-chain counterpart to `contracts/EVENTS.md`. The cursor
 * contract is the same idea: `(talosId, sequence)` is strictly monotonic and
 * never reordered, so a consumer resumes from the last sequence it committed
 * and replays forward. Appends are idempotent per `idempotencyKey`.
 *
 * Compatibility rules mirror the on-chain spec:
 *   - Additive (new event name, new `detail` field) — minor bump, safe.
 *   - Breaking (renamed/repurposed event) — introduce a new name; the old name
 *     is retired and its meaning is never reused.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { tlsLifecycleEvents } from "@/db/schema";
import { redactPayload } from "@/lib/redact";

import type { AgentLifecycleState, GovernanceRole } from "./lifecycle";

export const LIFECYCLE_EVENT_SPEC_VERSION = "1.0.0";

export const LIFECYCLE_EVENTS = {
  PROPOSED: "agent.lifecycle.proposed",
  PROVISIONING_STARTED: "agent.lifecycle.provisioning_started",
  STEP_COMPLETED: "agent.lifecycle.step_completed",
  STEP_FAILED: "agent.lifecycle.step_failed",
  COMPENSATION_STARTED: "agent.lifecycle.compensation_started",
  COMPENSATION_COMPLETED: "agent.lifecycle.compensation_completed",
  ACTIVATED: "agent.lifecycle.activated",
  PAUSED: "agent.lifecycle.paused",
  RETIRING: "agent.lifecycle.retiring",
  RETIRED: "agent.lifecycle.retired",
  RECOVERY_REQUESTED: "agent.lifecycle.recovery_requested",
  FAILED: "agent.lifecycle.failed",
} as const;

export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[keyof typeof LIFECYCLE_EVENTS];

export interface LifecycleEventInput {
  talosId: string;
  eventType: LifecycleEventName;
  fromState: AgentLifecycleState | null;
  toState: AgentLifecycleState;
  actorId: string;
  actorRole: GovernanceRole;
  jobId?: string | null;
  stepName?: string | null;
  detail?: Record<string, unknown>;
  /** Supply for at-least-once producers so a retry collapses onto one row. */
  idempotencyKey?: string | null;
}

/** Max `detail` size after redaction. Keeps one bad payload from bloating the log. */
const MAX_DETAIL_BYTES = 4_096;

/** Retries for the sequence race — bounded, so a hot agent cannot spin forever. */
const MAX_SEQUENCE_ATTEMPTS = 5;

/** Minimal query surface, so this works inside or outside a transaction. */
type Executor = Pick<typeof db, "select" | "insert">;

function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const redacted = redactPayload(detail);
  const encoded = JSON.stringify(redacted);
  if (encoded.length <= MAX_DETAIL_BYTES) return redacted;
  return { truncated: true, bytes: encoded.length };
}

/**
 * Append one event. Safe under concurrency: the `(talosId, sequence)` unique
 * index rejects a racing appender, and we re-read the tip and retry. Safe under
 * duplicate delivery: an existing row with the same idempotency key is returned
 * unchanged rather than appended twice.
 */
export async function emitLifecycleEvent(
  input: LifecycleEventInput,
  executor: Executor = db,
): Promise<{ id: string; sequence: number; deduped: boolean }> {
  const detail = sanitizeDetail(input.detail);

  if (input.idempotencyKey) {
    const existing = await executor
      .select({ id: tlsLifecycleEvents.id, sequence: tlsLifecycleEvents.sequence })
      .from(tlsLifecycleEvents)
      .where(
        and(
          eq(tlsLifecycleEvents.talosId, input.talosId),
          eq(tlsLifecycleEvents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing) return { ...existing, deduped: true };
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt++) {
    const tip = await executor
      .select({ sequence: tlsLifecycleEvents.sequence })
      .from(tlsLifecycleEvents)
      .where(eq(tlsLifecycleEvents.talosId, input.talosId))
      .orderBy(desc(tlsLifecycleEvents.sequence))
      .limit(1)
      .then((r) => r[0]?.sequence ?? 0);

    try {
      const [row] = await executor
        .insert(tlsLifecycleEvents)
        .values({
          talosId: input.talosId,
          sequence: tip + 1,
          eventType: input.eventType,
          fromState: input.fromState,
          toState: input.toState,
          actorId: input.actorId,
          actorRole: input.actorRole,
          jobId: input.jobId ?? null,
          stepName: input.stepName ?? null,
          detail,
          idempotencyKey: input.idempotencyKey ?? null,
        })
        .returning({ id: tlsLifecycleEvents.id, sequence: tlsLifecycleEvents.sequence });

      return { ...row, deduped: false };
    } catch (err) {
      lastError = err;
      // Either the sequence or the idempotency key collided. Both resolve by
      // re-reading: a key collision means a concurrent producer already wrote
      // this exact event, which is the outcome we wanted anyway.
      if (input.idempotencyKey) {
        const winner = await executor
          .select({ id: tlsLifecycleEvents.id, sequence: tlsLifecycleEvents.sequence })
          .from(tlsLifecycleEvents)
          .where(
            and(
              eq(tlsLifecycleEvents.talosId, input.talosId),
              eq(tlsLifecycleEvents.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
          .then((r) => r[0] ?? null);

        if (winner) return { ...winner, deduped: true };
      }
    }
  }

  throw new Error(
    `Failed to append lifecycle event ${input.eventType} after ${MAX_SEQUENCE_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

export interface LifecycleEventRow {
  id: string;
  sequence: number;
  eventType: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  actorRole: string;
  jobId: string | null;
  stepName: string | null;
  detail: unknown;
  createdAt: Date;
}

/**
 * Read a page of history, newest first. `beforeSequence` is the keyset cursor —
 * offset pagination is deliberately avoided so a page cannot shift under a
 * reader while new events are being appended.
 */
export async function readLifecycleEvents(
  talosId: string,
  opts: { limit?: number; beforeSequence?: number } = {},
): Promise<{ events: LifecycleEventRow[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const rows = await db
    .select({
      id: tlsLifecycleEvents.id,
      sequence: tlsLifecycleEvents.sequence,
      eventType: tlsLifecycleEvents.eventType,
      fromState: tlsLifecycleEvents.fromState,
      toState: tlsLifecycleEvents.toState,
      actorId: tlsLifecycleEvents.actorId,
      actorRole: tlsLifecycleEvents.actorRole,
      jobId: tlsLifecycleEvents.jobId,
      stepName: tlsLifecycleEvents.stepName,
      detail: tlsLifecycleEvents.detail,
      createdAt: tlsLifecycleEvents.createdAt,
    })
    .from(tlsLifecycleEvents)
    .where(
      opts.beforeSequence
        ? and(
            eq(tlsLifecycleEvents.talosId, talosId),
            sql`${tlsLifecycleEvents.sequence} < ${opts.beforeSequence}`,
          )
        : eq(tlsLifecycleEvents.talosId, talosId),
    )
    .orderBy(desc(tlsLifecycleEvents.sequence))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].sequence : null;

  return { events: page, nextCursor };
}

/** Current state from the event log tip, or null when the agent has no history. */
export async function currentStateFromLog(
  talosId: string,
): Promise<{ state: AgentLifecycleState; sequence: number } | null> {
  const tip = await db
    .select({ toState: tlsLifecycleEvents.toState, sequence: tlsLifecycleEvents.sequence })
    .from(tlsLifecycleEvents)
    .where(eq(tlsLifecycleEvents.talosId, talosId))
    .orderBy(desc(tlsLifecycleEvents.sequence))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!tip) return null;
  return { state: tip.toState as AgentLifecycleState, sequence: tip.sequence };
}
