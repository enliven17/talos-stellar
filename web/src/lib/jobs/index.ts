/**
 * Durable background-job execution framework (web boundary).
 *
 * A Postgres-backed job queue: `enqueue()` writes a durable row, workers
 * lease batches with `SELECT ... FOR UPDATE SKIP LOCKED` (safe across
 * multiple app instances with no broker), heartbeat while processing, and
 * either complete, retry with backoff, or dead-letter on exhaustion.
 *
 * See web/JOBS.md for configuration, operational signals, and rollback.
 */
export {
  enqueue,
  executeBulkRetry,
  getJob,
  getJobRevision,
  listJobs,
  previewBulkRetry,
  release,
  requestCancel,
  requeue,
} from "./store";
export { registerHandler } from "./registry";
export { runOnce } from "./runner";
export type { RunOnceOptions } from "./runner";
export { jobsConfig, JOBS_ENABLED } from "./config";
export { boundError, boundResult, truncateError, truncateResult } from "./metrics";
export type {
  BulkRetryCandidate,
  BulkRetryExcluded,
  BulkRetryExecutionResult,
  BulkRetryFilter,
  BulkRetryPreview,
  BulkRetryReason,
  BulkRetrySelection,
  BulkRetrySkipReason,
  BulkRetrySkippedItem,
  EnqueueOptions,
  JobAttemptRecord,
  JobContext,
  JobHandler,
  JobRecord,
  JobStatus,
  LeaseExtensionRejectionReason,
  RetryClass,
  RunOnceSummary,
} from "./types";
