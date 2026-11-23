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

/** Terminal reason for an execution attempt */
export type AttemptTerminalReason = "completed" | "retry_scheduled" | "dead_letter" | "cancelled";

/** Bounded attempt execution record stored in tls_job_attempts */
export interface JobAttemptRecord {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string | null;
  leaseId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  terminalReason: AttemptTerminalReason;
  error: string | null;
  createdAt: Date;
}

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
  /** false when the lease was lost (reaped/re-leased elsewhere, or lease deadline elapsed) or cancellation was requested. */
  ok: boolean;
  cancelled: boolean;
}

/** Reason codes for a rejected lease extension request. */
export type LeaseExtensionRejectionReason =
  | "invalid_duration"
  | "exceeds_max_extension"
  | "exceeds_max_horizon"
  | "would_shorten_lease"
  | "not_found"
  | "invalid_job_state"
  | "cancellation_requested"
  | "no_active_lease"
  | "lease_expired"
  | "lease_mismatch";

/** Result returned by extendLease() calls. */
export interface ExtendLeaseResult {
  /** true when the lease was extended; false when rejected or lost. */
  ok: boolean;
  cancelled: boolean;
  leaseExpiresAt: Date | null;
  reason?: LeaseExtensionRejectionReason;
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
  heartbeat: (leaseDurationMs?: number) => Promise<HeartbeatResult>;
  /**
   * Additively extends the current lease expiry by `extensionMs` after
   * validating extension limits against current expiry and job state.
   * Rejects contradictory requests without modifying the held lease.
   */
  extendLease: (extensionMs: number) => Promise<ExtendLeaseResult>;
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
  /** Pending jobs expired by queue-age deadline (never ran; attempts unchanged). */
  agedOut: number;
}

/**
 * Bounded diagnostic envelope stored in `tls_jobs.result` when a handler's
 * return value exceeds `jobsConfig.maxResultBytes` or cannot be serialized
 * to JSON. Prevents unbounded database writes while retaining a stable,
 * machine-readable diagnostic for operators.
 */
export interface BoundedResultDiagnostic {
  truncated: true;
  reason: "result_exceeds_max_bytes" | "result_unserializable";
  maxBytes: number;
  actualBytes: number | null;
  diagnostic: string;
}

export interface BoundResultOutcome {
  value: unknown;
  truncated: boolean;
  reason?: "result_exceeds_max_bytes" | "result_unserializable";
  actualBytes?: number;
  maxBytes: number;
}

export interface BoundErrorOutcome {
  value: string;
  truncated: boolean;
  actualBytes: number;
  maxBytes: number;
}

export type BulkRetryReason =
  | "eligible"
  | "not_found"
  | "status_not_failed"
  | "cancelled_excluded"
  | "queue_mismatch"
  | "retry_class_mismatch"
  | "fatal_retry_class";

export type BulkRetrySkipReason =
  | Exclude<BulkRetryReason, "eligible">
  | "revision_mismatch"
  | "invalid_revision";

export interface BulkRetryFilter {
  /** Explicit job IDs to evaluate. When omitted, scans matching jobs up to `limit`. */
  jobIds?: string[];
  queue?: string;
  retryClass?: RetryClass;
  /** Include `cancelled` jobs in addition to `dead_letter`. Defaults to false. */
  includeCancelled?: boolean;
  /** Allow retrying `fatal` retryClass jobs. Defaults to false. */
  allowFatal?: boolean;
  /** Max jobs to scan when `jobIds` is not supplied (default 50, max 200). */
  limit?: number;
}

export interface BulkRetryCandidate {
  id: string;
  queue: string;
  status: JobStatus;
  retryClass: RetryClass;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  revision: string;
  reason: "eligible";
}

export interface BulkRetryExcluded {
  id: string;
  queue: string | null;
  status: JobStatus | null;
  retryClass: RetryClass | null;
  revision: string | null;
  reason: Exclude<BulkRetryReason, "eligible">;
}

export interface BulkRetryPreview {
  dryRun: true;
  totalEvaluated: number;
  eligibleCount: number;
  ineligibleCount: number;
  countsByReason: Partial<Record<BulkRetryReason, number>>;
  eligible: BulkRetryCandidate[];
  ineligible: BulkRetryExcluded[];
}

export interface BulkRetrySelection {
  id: string;
  /** Unchanged job revision token returned by `previewBulkRetry` (`updatedAt` ISO string). */
  revision: string;
}

export interface BulkRetrySkippedItem {
  id: string;
  expectedRevision: string;
  currentRevision: string | null;
  reason: BulkRetrySkipReason;
}

export interface BulkRetryExecutionResult {
  dryRun: false;
  requestedCount: number;
  requeuedCount: number;
  skippedCount: number;
  requeued: JobRecord[];
  skipped: BulkRetrySkippedItem[];
}
