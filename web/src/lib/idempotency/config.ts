/**
 * Configuration for bounded, completed-only idempotency-key cleanup.
 *
 * Scope: `tls_commerce_jobs` — the commerce idempotency ledger documented in
 * `docs/idempotency-design.md`. Only records that have reached the terminal
 * "completed" state are ever eligible; in-flight (pending / negotiating /
 * counter_offer) records are never touched.
 *
 * Every knob is environment-overridable and falls back to a safe default when
 * the variable is absent or malformed, so a misconfigured deployment degrades
 * to the defaults instead of failing open.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on rows removed per cleanup run. Even if an operator passes a
 * huge `?limit=`, a run can never delete more than this, so cleanup can never
 * become an unbounded delete.
 */
export const IDEMPOTENCY_CLEANUP_MAX_BATCH = 5_000;

const DEFAULT_RETENTION_MS = 30 * DAY_MS;
const DEFAULT_CLEANUP_BATCH_SIZE = 500;

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const idempotencyConfig = {
  /**
   * How long a completed idempotency key is retained before it becomes
   * eligible for cleanup, in milliseconds. Longer retention widens the replay
   * window; shorter reclaims storage sooner. Default: 30 days.
   */
  retentionMs: envPositiveInt("IDEMPOTENCY_KEY_RETENTION_MS", DEFAULT_RETENTION_MS),

  /** Default max rows deleted per cleanup run, clamped to [1, MAX_BATCH]. */
  cleanupBatchSize: clamp(
    envPositiveInt("IDEMPOTENCY_CLEANUP_BATCH_SIZE", DEFAULT_CLEANUP_BATCH_SIZE),
    1,
    IDEMPOTENCY_CLEANUP_MAX_BATCH,
  ),
};

/**
 * Resolves the effective per-run row cap.
 *
 * Absent, non-numeric, or sub-1 values fall back to the configured default
 * (so a malformed `?limit=` cannot be interpreted as "no limit"). Valid
 * values are floored and clamped to [1, IDEMPOTENCY_CLEANUP_MAX_BATCH].
 */
export function resolveCleanupBatchSize(requested?: number | null): number {
  if (requested === undefined || requested === null) {
    return idempotencyConfig.cleanupBatchSize;
  }
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
    return idempotencyConfig.cleanupBatchSize;
  }
  return clamp(Math.floor(requested), 1, IDEMPOTENCY_CLEANUP_MAX_BATCH);
}
