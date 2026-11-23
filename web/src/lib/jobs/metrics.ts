import { logger } from "@/lib/logger";
import { buildLogEvent } from "@/lib/log-schema";
import { jobsConfig } from "./config";
import type { BoundedResultDiagnostic, BoundErrorOutcome, BoundResultOutcome } from "./types";

/**
 * Structured job-lifecycle events. Deliberately never includes `payload`,
 * `result`, or raw error objects (which can carry request bodies / secrets
 * in their message or cause) — only identifiers, counters, and durations.
 * `lastError` and `result` on the row are independently bounded before
 * persistence for the same reason; see boundError() and boundResult() below.
 *
 * Fields go through the shared log schema (`buildLogEvent`): `schemaVersion`
 * is stamped, scalars are bounded, sensitive keys redacted — signature
 * unchanged.
 */
export type JobEvent =
  | "job_enqueued"
  | "job_leased"
  | "job_heartbeat"
  | "job_lease_extended"
  | "job_lease_extension_rejected"
  | "job_completed"
  | "job_retry_scheduled"
  | "job_dead_letter"
  | "job_cancelled"
  | "job_lease_reaped"
  | "job_result_truncated"
  | "job_error_truncated";

export interface JobLogFields {
  jobId: string;
  queue: string;
  attempts?: number;
  maxAttempts?: number;
  retryClass?: string;
  durationMs?: number;
  delayMs?: number;
  workerId?: string;
  reason?: string;
  actualBytes?: number;
  maxBytes?: number;
}

export function logJobEvent(event: JobEvent, fields: JobLogFields): void {
  const built = buildLogEvent(event, fields);
  logger.info(built, built.event);
}

export const DEFAULT_MAX_ERROR_BYTES = 500;
export const DEFAULT_MAX_RESULT_BYTES = 65_536;

/**
 * Slices a string so its UTF-8 byte length is at most `maxBytes` without
 * splitting surrogate pairs / multi-byte code points.
 */
function sliceUtf8ByBytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;

  let low = 0;
  let high = Math.min(input.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // Avoid leaving a trailing lone high surrogate at the cut boundary.
  if (low > 0) {
    const code = input.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      low -= 1;
    }
  }
  return input.slice(0, low);
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "[unrepresentable error]";
  }
}

/**
 * Bounds an unknown error to a short, log-safe diagnostic string (message
 * only, no stack, no cause chain) capped at `maxBytes` UTF-8 bytes
 * (defaulting to `jobsConfig.maxErrorBytes`).
 */
export function boundError(err: unknown, maxBytes: number = jobsConfig.maxErrorBytes): BoundErrorOutcome {
  const effectiveMax = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_ERROR_BYTES;
  const message = extractErrorMessage(err);
  const actualBytes = Buffer.byteLength(message, "utf8");
  if (actualBytes <= effectiveMax) {
    return { value: message, truncated: false, actualBytes, maxBytes: effectiveMax };
  }
  const prefix = sliceUtf8ByBytes(message, effectiveMax);
  return {
    value: `${prefix}…`,
    truncated: true,
    actualBytes,
    maxBytes: effectiveMax,
  };
}

/** Reduces an unknown error to a short, log-safe string (message only, no stack, no cause chain). */
export function truncateError(err: unknown, maxBytes: number = jobsConfig.maxErrorBytes): string {
  return boundError(err, maxBytes).value;
}

/**
 * Bounds a handler result independently of `lastError` before database
 * persistence. If the JSON-serialized result fits within `maxBytes`
 * (defaulting to `jobsConfig.maxResultBytes`), the original value is kept;
 * otherwise (or if serialization fails) a stable, bounded diagnostic envelope
 * is returned so the database never receives an unbounded write.
 */
export function boundResult(result: unknown, maxBytes: number = jobsConfig.maxResultBytes): BoundResultOutcome {
  const effectiveMax = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_RESULT_BYTES;
  if (result === undefined || result === null) {
    return { value: null, truncated: false, actualBytes: 4, maxBytes: effectiveMax };
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    const envelope: BoundedResultDiagnostic = {
      truncated: true,
      reason: "result_unserializable",
      maxBytes: effectiveMax,
      actualBytes: null,
      diagnostic: "job result could not be serialized to JSON",
    };
    return {
      value: envelope,
      truncated: true,
      reason: "result_unserializable",
      maxBytes: effectiveMax,
    };
  }

  if (serialized === undefined) {
    return { value: null, truncated: false, actualBytes: 4, maxBytes: effectiveMax };
  }

  const actualBytes = Buffer.byteLength(serialized, "utf8");
  if (actualBytes <= effectiveMax) {
    return { value: result, truncated: false, actualBytes, maxBytes: effectiveMax };
  }

  const envelope: BoundedResultDiagnostic = {
    truncated: true,
    reason: "result_exceeds_max_bytes",
    maxBytes: effectiveMax,
    actualBytes,
    diagnostic: `job result size (${actualBytes} bytes) exceeded maxResultBytes (${effectiveMax} bytes)`,
  };
  return {
    value: envelope,
    truncated: true,
    reason: "result_exceeds_max_bytes",
    actualBytes,
    maxBytes: effectiveMax,
  };
}

/** Convenience wrapper returning the persisted result value or bounded diagnostic envelope. */
export function truncateResult(result: unknown, maxBytes: number = jobsConfig.maxResultBytes): unknown {
  return boundResult(result, maxBytes).value;
}
