/**
 * Privacy-safe observability for drift detection events.
 *
 * Rules enforced here:
 *   1. Field VALUES are never logged — only paths, types, and counts.
 *   2. All log entries include requestId for correlation.
 *   3. A module-level counter tracks violations since process start so
 *      operators can monitor saturation without a metrics backend.
 *
 * To wire these into a real metrics backend (Prometheus, Datadog, etc.) add
 * an optional exporter at the bottom of this file.
 */

import { logger } from "../logger.js";
import type { DriftViolation, DriftMode } from "./types.js";

// ── In-process counters (lightweight; reset on restart) ───────────────────────

const counters = {
  validated: 0,
  skipped: 0,   // sampled out or mode=off
  warned: 0,    // violation in warn mode
  rejected: 0,  // violation in strict mode
  errors: 0,    // unexpected validator exceptions
};

/** Read-only snapshot of the current counters (safe to expose via /api/health). */
export function getDriftCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/** Reset counters — intended for tests only. */
export function resetDriftCounters(): void {
  counters.validated = 0;
  counters.skipped = 0;
  counters.warned = 0;
  counters.rejected = 0;
  counters.errors = 0;
}

// ── Log helpers ───────────────────────────────────────────────────────────────

/** Called when a request is skipped (mode=off or sampled out). */
export function recordSkip(): void {
  counters.skipped += 1;
}

/** Called when validation passes with no violations. */
export function recordClean(requestId: string, routeKey: string): void {
  counters.validated += 1;
  // Debug-level only — no production noise for clean requests
  logger.debug({ requestId, routeKey, drift: "clean" }, "drift: no violations");
}

/**
 * Called when violations are found in warn mode.
 * Logs each violation's path and kind but NEVER the field value.
 */
export function recordWarn(
  requestId: string,
  routeKey: string,
  violations: DriftViolation[],
): void {
  counters.validated += 1;
  counters.warned += violations.length;

  logger.warn(
    {
      requestId,
      routeKey,
      drift: "warn",
      violationCount: violations.length,
      // Serialize only safe fields — path, kind, expectedType, receivedType
      violations: violations.map(({ path, kind, message, expectedType, receivedType }) => ({
        path,
        kind,
        message,
        expectedType,
        receivedType,
      })),
    },
    "drift: violations detected (warn mode — request allowed)",
  );
}

/**
 * Called when violations are found in strict mode and the request is rejected.
 */
export function recordReject(
  requestId: string,
  routeKey: string,
  violations: DriftViolation[],
): void {
  counters.validated += 1;
  counters.rejected += violations.length;

  logger.warn(
    {
      requestId,
      routeKey,
      drift: "strict",
      violationCount: violations.length,
      violations: violations.map(({ path, kind, message, expectedType, receivedType }) => ({
        path,
        kind,
        message,
        expectedType,
        receivedType,
      })),
    },
    "drift: violations detected (strict mode — request rejected)",
  );
}

/**
 * Called when the validator itself throws an unexpected error.
 * The error is swallowed — never blocks a real request.
 */
export function recordValidatorError(
  requestId: string,
  routeKey: string,
  mode: DriftMode,
  err: unknown,
): void {
  counters.errors += 1;
  logger.error(
    { requestId, routeKey, mode, err },
    "drift: internal validator error (request allowed)",
  );
}

/**
 * Called when no schema is registered for a route (only logged at debug level
 * so operators aren't flooded for routes that intentionally have no schema).
 */
export function recordNoSchema(requestId: string, routeKey: string): void {
  logger.debug(
    { requestId, routeKey, drift: "no_schema" },
    "drift: no schema registered for route",
  );
}
