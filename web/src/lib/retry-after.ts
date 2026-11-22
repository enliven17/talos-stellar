/**
 * Bounded `Retry-After` and reset-timestamp helpers for quota and rate-limit responses.
 *
 * Pure and Edge-runtime compatible (no Node-only built-ins) so it can be shared
 * between Next.js API routes (`quota.ts`) and Edge middleware (`rate-limit.ts`).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum Retry-After delay (seconds) emitted on any 429 response. */
export const MIN_RETRY_AFTER_SECONDS = 1;

/** Default upper cap (seconds) for computed Retry-After headers (1 hour). */
export const DEFAULT_MAX_RETRY_AFTER_SECONDS = 3_600;

/** Hard ceiling (seconds) for Retry-After configuration overrides (24 hours). */
export const ABSOLUTE_MAX_RETRY_AFTER_SECONDS = 86_400;

/** Default finite fallback delay (seconds) when the window reset time is unknown. */
export const DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS = 60;

/** Maximum valid ECMAScript Date timestamp (milliseconds since Unix epoch). */
export const MAX_VALID_EPOCH_MS = 8_640_000_000_000_000;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Options controlling bounded Retry-After computation. */
export interface RetryAfterOptions {
  /** Current time override in Unix epoch milliseconds (defaults to `Date.now()`). */
  nowMs?: number;
  /** Override maximum Retry-After cap in seconds (clamped to [1, 86400]). */
  maxRetryAfterSeconds?: number;
  /** Override finite delay in seconds when `resetAt` is unknown/invalid. */
  unknownResetRetryAfterSeconds?: number;
  /** Environment variable map override (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

// ─── Env resolution ──────────────────────────────────────────────────────────

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/**
 * Resolve the configured maximum `Retry-After` cap (seconds) from
 * `QUOTA_MAX_RETRY_AFTER_SECONDS`, falling back to `DEFAULT_MAX_RETRY_AFTER_SECONDS`.
 */
export function resolveMaxRetryAfterSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseBoundedPositiveInt(
    env.QUOTA_MAX_RETRY_AFTER_SECONDS,
    DEFAULT_MAX_RETRY_AFTER_SECONDS,
    MIN_RETRY_AFTER_SECONDS,
    ABSOLUTE_MAX_RETRY_AFTER_SECONDS,
  );
}

/**
 * Resolve the finite fallback `Retry-After` delay (seconds) used when the
 * window reset time is unknown or invalid, from `QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS`.
 */
export function resolveUnknownResetRetryAfterSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseBoundedPositiveInt(
    env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
    DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
    MIN_RETRY_AFTER_SECONDS,
    ABSOLUTE_MAX_RETRY_AFTER_SECONDS,
  );
}

// ─── Reset timestamp validation & formatting ─────────────────────────────────

/**
 * Return true iff `resetAt` is a finite positive Unix-epoch millisecond
 * timestamp within the valid ECMAScript Date range.
 */
export function isValidResetAt(resetAt: unknown): resetAt is number {
  return (
    typeof resetAt === "number" &&
    Number.isFinite(resetAt) &&
    resetAt > 0 &&
    resetAt <= MAX_VALID_EPOCH_MS
  );
}

/**
 * Format `resetAt` (Unix ms) as a positive integer Unix-epoch seconds string,
 * or `null` when `resetAt` is unknown/invalid.
 */
export function formatResetEpochSeconds(resetAt: unknown): string | null {
  if (!isValidResetAt(resetAt)) return null;
  return String(Math.ceil(resetAt / 1_000));
}

/**
 * Format `resetAt` (Unix ms) as an ISO-8601 timestamp string,
 * or `null` when `resetAt` is unknown/invalid. Never throws `RangeError`.
 */
export function formatResetIsoString(resetAt: unknown): string | null {
  if (!isValidResetAt(resetAt)) return null;
  return new Date(resetAt).toISOString();
}

// ─── Retry-After computation ─────────────────────────────────────────────────

/**
 * Compute a bounded, finite `Retry-After` delay in whole seconds (`>= 1`).
 *
 * - Valid future `resetAt`: `ceil((resetAt - nowMs) / 1000)`, clamped to `[1, maxRetryAfterSeconds]`.
 * - Valid past/current `resetAt` (`deltaMs <= 0`): `1` (minimum positive retry delay).
 * - Unknown/invalid `resetAt` (`null`, `undefined`, `NaN`, `Infinity`, `<= 0`, out-of-range):
 *   returns `min(unknownResetRetryAfterSeconds, maxRetryAfterSeconds)`.
 */
export function computeRetryAfterSeconds(
  resetAt: unknown,
  options?: RetryAfterOptions,
): number {
  const env = options?.env ?? process.env;

  const optMax = options?.maxRetryAfterSeconds;
  const maxSec =
    typeof optMax === "number" &&
    Number.isFinite(optMax) &&
    optMax >= MIN_RETRY_AFTER_SECONDS
      ? Math.min(Math.floor(optMax), ABSOLUTE_MAX_RETRY_AFTER_SECONDS)
      : resolveMaxRetryAfterSeconds(env);

  const optFallback = options?.unknownResetRetryAfterSeconds;
  const rawFallback =
    typeof optFallback === "number" &&
    Number.isFinite(optFallback) &&
    optFallback >= MIN_RETRY_AFTER_SECONDS
      ? Math.floor(optFallback)
      : resolveUnknownResetRetryAfterSeconds(env);
  const fallbackSec = Math.min(rawFallback, maxSec);

  if (!isValidResetAt(resetAt)) {
    return fallbackSec;
  }

  const now =
    typeof options?.nowMs === "number" && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();

  const deltaMs = resetAt - now;
  if (!Number.isFinite(deltaMs)) {
    return fallbackSec;
  }

  if (deltaMs <= 0) {
    return MIN_RETRY_AFTER_SECONDS;
  }

  const rawSeconds = Math.ceil(deltaMs / 1_000);
  if (!Number.isFinite(rawSeconds)) {
    return maxSec;
  }

  return Math.min(maxSec, Math.max(MIN_RETRY_AFTER_SECONDS, rawSeconds));
}
