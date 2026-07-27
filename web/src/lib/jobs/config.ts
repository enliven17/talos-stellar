import { randomUUID } from "crypto";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Master switch. Defaults to disabled so rollout is opt-in: existing code
 * paths that could integrate with the queue (e.g. the audit-log write in
 * auth.ts) keep their pre-existing synchronous/fire-and-forget behavior
 * until an operator explicitly sets JOBS_ENABLED=true.
 */
export const JOBS_ENABLED = process.env.JOBS_ENABLED === "true";

export const jobsConfig = {
  enabled: JOBS_ENABLED,

  /** How long a lease is held before it's eligible for reaping, in ms. */
  leaseDurationMs: envInt("JOBS_LEASE_DURATION_MS", 30_000),

  /** How often a running handler should be expected to heartbeat, in ms. */
  heartbeatIntervalMs: envInt("JOBS_HEARTBEAT_INTERVAL_MS", 10_000),

  /** Max jobs claimed per runOnce() batch. */
  batchSize: envInt("JOBS_BATCH_SIZE", 10),

  /** Default maxAttempts for newly enqueued jobs that don't specify one. */
  defaultMaxAttempts: envInt("JOBS_DEFAULT_MAX_ATTEMPTS", 8),

  /** Continuous-worker poll interval when the queue is empty, in ms. */
  pollIntervalMs: envInt("JOBS_POLL_INTERVAL_MS", 2_000),

  /** Grace period for in-flight jobs to finish during graceful shutdown, in ms. */
  shutdownGraceMs: envInt("JOBS_SHUTDOWN_GRACE_MS", 10_000),

  /** Identifies this process in leaseOwner / logs. Stable per process lifetime. */
  workerId: process.env.JOBS_WORKER_ID || `${process.pid}-${randomUUID().slice(0, 8)}`,
};

/** Bearer token for /api/admin/jobs/* inspection endpoints. */
export function getAdminApiKey(): string | null {
  return process.env.ADMIN_API_KEY || null;
}

/** Shared-secret header for the /api/internal/jobs/drain endpoint (cron/Railway trigger). */
export function getInternalJobsSecret(): string | null {
  return process.env.INTERNAL_JOBS_SECRET || null;
}
