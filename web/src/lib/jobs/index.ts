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
export { enqueue, extendLease, getJob, heartbeat, listJobs, release, requestCancel, requeue } from "./store";
export type { ExtendLeaseOptions } from "./store";
export { registerHandler } from "./registry";
export { runOnce } from "./runner";
export type { RunOnceOptions } from "./runner";
export { jobsConfig, JOBS_ENABLED } from "./config";
export type {
  EnqueueOptions,
  ExtendLeaseResult,
  HeartbeatResult,
  JobContext,
  JobHandler,
  JobRecord,
  JobStatus,
  LeaseExtensionRejectionReason,
  RetryClass,
  RunOnceSummary,
} from "./types";
