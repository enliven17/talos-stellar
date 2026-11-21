import { logger } from "@/lib/logger";
import { buildLogEvent } from "@/lib/log-schema";

/**
 * Structured event-lifecycle logs. Never includes `payload` or a raw error
 * object — only identifiers and counters. `lastError` on the row is
 * truncated the same way (see truncateError below), so a handler error
 * message can't smuggle a large blob into logs either.
 *
 * Fields are passed through the shared log schema (`buildLogEvent`), which
 * stamps `schemaVersion`, keeps scalars only, and redacts sensitive keys —
 * the `(event, fields)` signature is unchanged.
 */
export type OutboxLogEvent =
  | "outbox_event_written"
  | "outbox_event_leased"
  | "outbox_event_dispatched"
  | "outbox_event_retry_scheduled"
  | "outbox_event_dead_letter"
  | "outbox_lease_reaped"
  | "outbox_events_pruned";

export function logOutboxEvent(event: OutboxLogEvent, fields: Record<string, unknown>): void {
  const built = buildLogEvent(event, fields);
  logger.info(built, built.event);
}

const MAX_ERROR_LEN = 500;

export function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_LEN ? `${message.slice(0, MAX_ERROR_LEN)}…` : message;
}
