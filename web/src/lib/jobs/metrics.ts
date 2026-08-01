import { logger } from "@/lib/logger";

/**
 * Structured job-lifecycle events. Deliberately never includes `payload`,
 * `result`, or raw error objects (which can carry request bodies / secrets
 * in their message or cause) — only identifiers, counters, and durations.
 * `lastError` on the row is a caller-truncated string for the same reason;
 * see truncateError() below.
 */
export type JobEvent =
  | "job_enqueued"
  | "job_leased"
  | "job_heartbeat"
  | "job_completed"
  | "job_retry_scheduled"
  | "job_dead_letter"
  | "job_cancelled"
  | "job_lease_reaped";

export interface JobLogFields {
  jobId: string;
  queue: string;
  attempts?: number;
  maxAttempts?: number;
  retryClass?: string;
  durationMs?: number;
  delayMs?: number;
  workerId?: string;
}

export function logJobEvent(event: JobEvent, fields: JobLogFields): void {
  logger.info({ event, ...fields }, event);
}

const MAX_ERROR_LEN = 500;

/** Reduces an unknown error to a short, log-safe string (message only, no stack, no cause chain). */
export function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_LEN ? `${message.slice(0, MAX_ERROR_LEN)}…` : message;
}
