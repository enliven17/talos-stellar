import { randomUUID } from "crypto";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Master switch. Defaults to disabled — opt-in, backward-compatible rollout. */
export const OUTBOX_ENABLED = process.env.OUTBOX_ENABLED === "true";

export const outboxConfig = {
  enabled: OUTBOX_ENABLED,
  /** Dispatch is expected to be fast (calling in-process consumers), so the lease window is short. */
  leaseDurationMs: envInt("OUTBOX_LEASE_DURATION_MS", 15_000),
  batchSize: envInt("OUTBOX_BATCH_SIZE", 25),
  defaultMaxAttempts: envInt("OUTBOX_DEFAULT_MAX_ATTEMPTS", 8),
  pollIntervalMs: envInt("OUTBOX_POLL_INTERVAL_MS", 2_000),
  /** Dispatched events older than this are eligible for pruning (retention). */
  retentionDays: envInt("OUTBOX_RETENTION_DAYS", 7),
  workerId: process.env.OUTBOX_WORKER_ID || `${process.pid}-${randomUUID().slice(0, 8)}`,
};

/** Bearer token for /api/admin/outbox/* inspection endpoints. */
export function getAdminApiKey(): string | null {
  return process.env.ADMIN_API_KEY || null;
}

/** Shared-secret header for the /api/internal/outbox/drain endpoint (cron/Railway trigger). */
export function getOutboxDispatchSecret(): string | null {
  return process.env.OUTBOX_DISPATCH_SECRET || null;
}
