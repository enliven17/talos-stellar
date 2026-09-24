/**
 * Shared utilities for health probe routes.
 *
 * withTimeout wraps any promise-producing function and rejects after `ms`
 * milliseconds.  It propagates an `AbortSignal` to the caller so that
 * in-flight I/O (e.g. `fetch`) can be *actively cancelled* on timeout
 * instead of continuing in the background.
 *
 * The timer handle is cleared on every code path (resolve, reject, timeout)
 * so no dangling timer is ever leaked.
 *
 * Timeouts are environment-configurable:
 *   HEALTH_DB_TIMEOUT_MS      (default 2000, clamp 1..60000)
 *   HEALTH_STELLAR_TIMEOUT_MS (default 3000, clamp 1..60000)
 * Malformed / out-of-range values fall back to the defaults so probes stay
 * bounded even when operators misconfigure the environment.
 */

export const DEFAULT_HORIZON = "https://horizon.stellar.org";
export const DEFAULT_DB_TIMEOUT_MS = 2000;
export const DEFAULT_STELLAR_TIMEOUT_MS = 3000;

/** @deprecated Prefer resolveDbTimeoutMs() — kept for existing test imports. */
export const DB_TIMEOUT_MS = DEFAULT_DB_TIMEOUT_MS;
/** @deprecated Prefer resolveStellarTimeoutMs() — kept for existing test imports. */
export const STELLAR_TIMEOUT_MS = DEFAULT_STELLAR_TIMEOUT_MS;

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;

export function parseTimeoutMs(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) return fallback;
  return parsed;
}

export function resolveDbTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseTimeoutMs(env.HEALTH_DB_TIMEOUT_MS, DEFAULT_DB_TIMEOUT_MS);
}

export function resolveStellarTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseTimeoutMs(env.HEALTH_STELLAR_TIMEOUT_MS, DEFAULT_STELLAR_TIMEOUT_MS);
}

export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);

    Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Readiness severity model.
 *
 * - Critical dependencies (`db`): failure → `unavailable` (HTTP 503). The
 *   process should not receive traffic; this is readiness — not liveness.
 * - Soft dependencies (`stellar`): failure alone → `degraded` (HTTP 200).
 *   The process stays in rotation; operators get an explicit degraded signal
 *   without conflating it with a hard liveness / process failure.
 * - Liveness (`GET /api/health/live`) never inspects these checks.
 */
export type DependencyStatus = "ok" | "error";
export type ReadinessStatus = "ok" | "degraded" | "unavailable";

export type HealthChecks = {
  db: DependencyStatus;
  stellar: DependencyStatus;
};

export const CRITICAL_DEPENDENCIES = ["db"] as const;
export const SOFT_DEPENDENCIES = ["stellar"] as const;

export type ReadinessSummary = {
  /** Aggregate readiness severity. */
  status: ReadinessStatus;
  /** True only when every dependency check passed. */
  ok: boolean;
  /** True when the process should keep receiving traffic (ok or degraded). */
  ready: boolean;
  /** HTTP status for the readiness response. */
  httpStatus: 200 | 503;
};

export function summarizeReadiness(checks: HealthChecks): ReadinessSummary {
  const criticalFailed = CRITICAL_DEPENDENCIES.some(
    (name) => checks[name] !== "ok",
  );
  const softFailed = SOFT_DEPENDENCIES.some((name) => checks[name] !== "ok");

  if (criticalFailed) {
    return {
      status: "unavailable",
      ok: false,
      ready: false,
      httpStatus: 503,
    };
  }
  if (softFailed) {
    return {
      status: "degraded",
      ok: false,
      ready: true,
      httpStatus: 200,
    };
  }
  return { status: "ok", ok: true, ready: true, httpStatus: 200 };
}
