/**
 * Structured logging schema for web log lines.
 *
 * Every structured log object built through this module has the shape:
 *
 *   { event: string; schemaVersion: 1; requestId?: string; ...fields }
 *
 * - `event` — snake_case name (`/^[a-z][a-z0-9_]*$/`, max 64 chars) so log
 *   drains can aggregate with bounded cardinality.
 * - `schemaVersion` — constant marker so operators can detect schema drift.
 * - `requestId` — only ever the sanitized `x-request-id` value (reuses
 *   `sanitizeRequestId` from `./api-response`; never generated here).
 * - `fields` — flat scalars only (`string | number | boolean | null`),
 *   at most 16 entries, string values truncated to 500 chars.
 *
 * Privacy / safety guarantees (fail closed):
 *   - Sensitivity policy is reused from `./redact` (`isSensitiveKey`) — this
 *     module defines no parallel secret list. Sensitive keys (seeds,
 *     tokens, payment proofs, media, …) are emitted as `[REDACTED]`.
 *   - Invalid event names are never echoed (they may carry secrets); the
 *     builder emits `invalid_log_event` with a `reason` code instead.
 *   - Builders are pure functions: no I/O, never throw, safe to retry.
 *   - The shared pino `logger` still applies `redactPayload` as a second
 *     defense layer; this schema is the first.
 *
 * @module log-schema
 */

import { isSensitiveKey, REDACTED } from "./redact";
import { sanitizeRequestId } from "./api-response";

/** Schema marker stamped on every built log object. Bump on breaking change. */
export const LOG_SCHEMA_VERSION = 1;

/** Max length of an `event` name (mirrors request-id bounded-cardinality rule). */
export const MAX_EVENT_NAME_LENGTH = 64;

/** Max length of a field key. */
export const MAX_FIELD_KEY_LENGTH = 64;

/** Max length of a string field value (matches `truncateError` caps). */
export const MAX_STRING_VALUE_LENGTH = 500;

/** Max number of context fields per log line (bounds sink cardinality). */
export const MAX_LOG_FIELDS = 16;

/** Event name used when the caller's `event` input is ambiguous. Never echoes input. */
export const INVALID_LOG_EVENT = "invalid_log_event";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Scalar-only field values keep log sinks predictable (no nesting, no blobs). */
export type LogFieldValue = string | number | boolean | null;

export type LogFields = Record<string, LogFieldValue>;

/** Why an `event` input was rejected. `missing` also covers empty strings. */
export type LogSchemaViolationReason = "missing" | "malformed" | "oversized";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** A built log object ready to hand to pino. */
export interface BuiltLogEvent extends LogFields {
  event: string;
  schemaVersion: number;
}

export interface BuildLogEventOptions {
  /** Forwarded only when it sanitizes to a safe `x-request-id` value. */
  requestId?: unknown;
}

/** True for well-formed `event` names (snake_case, bounded length). */
export function isValidEventName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EVENT_NAME_LENGTH &&
    EVENT_NAME_PATTERN.test(value)
  );
}

/** True for well-formed field keys (bounded, no spaces or punctuation). */
export function isValidFieldKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FIELD_KEY_LENGTH &&
    FIELD_KEY_PATTERN.test(value)
  );
}

/** Resolve a log level, fail-closed to `warn` (visible, non-paging). */
export function resolveLogLevel(input: unknown): LogLevel {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
      return normalized as LogLevel;
    }
  }
  return "warn";
}

function truncateValue(value: string): string {
  if (value.length <= MAX_STRING_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_VALUE_LENGTH)}…`;
}

/**
 * Reduce one candidate field value to a scalar, or `undefined` when the
 * value must be dropped (nested objects/arrays, functions, non-finite
 * numbers, symbols, bigints, `undefined`). Strings are truncated; the
 * decision never depends on secret content.
 */
export function sanitizeLogValue(value: unknown): LogFieldValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return truncateValue(value);
    case "number":
      return Number.isFinite(value) ? value : undefined;
    case "boolean":
      return value;
    default:
      return undefined;
  }
}

/**
 * Reduce an unknown fields candidate to a bounded, privacy-safe record.
 * Non-object input (including arrays) fails closed to `{}`. Sensitive keys
 * reuse the canonical policy from `./redact` and emit `[REDACTED]`.
 * Insertion order is preserved; fields past {@link MAX_LOG_FIELDS} are
 * dropped. Never throws.
 */
export function sanitizeLogFields(input: unknown): LogFields {
  const out: LogFields = {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  let kept = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (kept >= MAX_LOG_FIELDS) break;
    if (!isValidFieldKey(key)) continue;
    if (value === undefined) continue;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      kept += 1;
      continue;
    }
    const safe = sanitizeLogValue(value);
    if (safe === undefined) continue;
    out[key] = safe;
    kept += 1;
  }
  return out;
}

function classifyEventName(event: unknown):
  | { name: string }
  | { violation: LogSchemaViolationReason } {
  if (event === null || event === undefined) return { violation: "missing" };
  if (typeof event !== "string") return { violation: "malformed" };
  const trimmed = event.trim();
  if (!trimmed) return { violation: "missing" };
  if (trimmed.length > MAX_EVENT_NAME_LENGTH) return { violation: "oversized" };
  if (!EVENT_NAME_PATTERN.test(trimmed)) return { violation: "malformed" };
  return { name: trimmed };
}

/**
 * Build a schema-conformant log object. Fail-closed: an ambiguous `event`
 * yields `{ event: "invalid_log_event", schemaVersion: 1, reason }` — the
 * raw input is never echoed. `requestId` is included only when it
 * sanitizes via the shared `sanitizeRequestId`. Never throws.
 */
export function buildLogEvent(
  event: unknown,
  fields?: unknown,
  opts: BuildLogEventOptions = {},
): BuiltLogEvent {
  const classified = classifyEventName(event);
  const safeFields = sanitizeLogFields(fields);
  const requestId =
    typeof opts.requestId === "string"
      ? sanitizeRequestId(opts.requestId)
      : null;

  if ("violation" in classified) {
    return {
      event: INVALID_LOG_EVENT,
      schemaVersion: LOG_SCHEMA_VERSION,
      reason: classified.violation,
      ...(requestId ? { requestId } : {}),
    };
  }

  return {
    event: classified.name,
    schemaVersion: LOG_SCHEMA_VERSION,
    ...safeFields,
    ...(requestId ? { requestId } : {}),
  };
}
