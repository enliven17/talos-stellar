/** Terminal + in-flight states for a durable job. */
export type JobStatus = "pending" | "leased" | "completed" | "dead_letter" | "cancelled";

/**
 * Controls backoff shape and retry ceiling. See retry.ts for the concrete
 * policy each class maps to.
 *
 *   transient    — normal failures (network blips, timeouts): exponential backoff.
 *   rate_limited — upstream throttling: longer backoff, higher ceiling.
 *   fatal        — non-retryable (bad input, auth failure): dead-letter immediately.
 */
export type RetryClass = "transient" | "rate_limited" | "fatal";

export interface JobRecord<TPayload = unknown> {
  id: string;
  queue: string;
  payload: TPayload;
  status: JobStatus;
  priority: number;
  runAt: Date;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  attempts: number;
  maxAttempts: number;
  retryClass: RetryClass;
  cancelRequested: boolean;
  idempotencyKey: string | null;
  lastError: string | null;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface EnqueueOptions {
  /** Delay before the job becomes eligible for leasing. Default 0 (now). */
  delayMs?: number;
  priority?: number;
  maxAttempts?: number;
  retryClass?: RetryClass;
  /** Dedupe key, scoped per queue. A repeat enqueue with the same key is a no-op. */
  idempotencyKey?: string;
}

/** Result returned by heartbeat() calls inside a running handler. */
export interface HeartbeatResult {
  /** false when the lease was lost (reaped/re-leased elsewhere) or cancellation was requested. */
  ok: boolean;
  cancelled: boolean;
}

export interface JobContext<TPayload = unknown> {
  id: string;
  queue: string;
  attempts: number;
  maxAttempts: number;
  payload: TPayload;
  /**
   * Extends the lease and checks for cooperative cancellation. Long-running
   * handlers should call this periodically and abort (via `signal`) when
   * `cancelled` is true or `ok` is false.
   */
  heartbeat: () => Promise<HeartbeatResult>;
  /** Aborts when cancellation is requested or the process is shutting down. */
  signal: AbortSignal;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  ctx: JobContext<TPayload>,
) => Promise<TResult>;

export interface RunOnceSummary {
  leased: number;
  completed: number;
  retried: number;
  deadLettered: number;
  cancelled: number;
  reaped: number;
}
