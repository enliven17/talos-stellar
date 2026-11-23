/**
 * Stable SDK error-code taxonomy with versioned fixtures.
 *
 * The Talos SDK already throws a typed error hierarchy rooted at
 * {@link TalosAPIError}, where each subclass carries a stable string `code`.
 * This module adds the layer above it: a single, canonical mapping from any
 * thrown value (SDK error, signing error, or generic `Error`) to a stable
 * `(code, category, retryable)` classification, plus a JSON-safe, redacted
 * cause chain that serializes identically on Node and browser builds.
 *
 * Design goals:
 * - **Consistent** — `classifyError` maps transport, validation, quota and
 *   payment failures to the same category regardless of which call site threw.
 * - **Versioned** — {@link ERROR_TAXONOMY_VERSION} pins the contract; the
 *   committed fixture in `tests/fixtures/error-taxonomy.json` carries the same
 *   version and is drift-checked in CI so a taxonomy change must bump both.
 * - **Browser/Node-portable** — {@link toErrorContract} returns a plain,
 *   JSON-serializable object. Cause frames are plain `{ name, message, code? }`
 *   objects with secrets scrubbed and length bounded, so they never rely on
 *   Node-specific `inspect`/symbols and never OOM a structured log sink.
 * - **Privacy-safe** — no request bodies, credentials, or secrets surface;
 *   cause messages are scrubbed of bearer tokens, API keys and Stellar secrets.
 *
 * @module error-taxonomy
 */

import {
  TalosAPIError,
  type TalosErrorCode,
} from "./errors.js";

/**
 * Version of the error-code taxonomy contract. Bumped when the set of codes,
 * categories, or their mapping changes. The committed fixture
 * (`tests/fixtures/error-taxonomy.json`) carries the same version and is
 * drift-checked in CI.
 */
export const ERROR_TAXONOMY_VERSION = 1 as const;

/**
 * Coarse failure category. Each {@link TalosErrorCode} maps to exactly one
 * category, giving callers a stable, small set of buckets for routing,
 * alerting and dashboards.
 */
export type TalosErrorCategory =
  | "transport"
  | "validation"
  | "quota"
  | "payment"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "server"
  | "timeout"
  | "api";

/** Canonical mapping from a {@link TalosErrorCode} to its category. */
const CODE_TO_CATEGORY: Record<TalosErrorCode, TalosErrorCategory> = {
  validation_error: "validation",
  authentication_error: "authentication",
  forbidden: "authorization",
  not_found_error: "not_found",
  conflict_error: "conflict",
  payment_error: "payment",
  rate_limit_error: "quota",
  server_error: "server",
  transport_error: "transport",
  timeout_error: "timeout",
  api_error: "api",
};

/**
 * Map a stable {@link TalosErrorCode} to its coarse {@link TalosErrorCategory}.
 * Unknown codes fall back to `"api"`.
 */
export function codeToCategory(code: TalosErrorCode): TalosErrorCategory {
  return CODE_TO_CATEGORY[code] ?? "api";
}

/** The canonical classification of a thrown value. */
export interface ErrorClassification {
  /** Stable string discriminator (matches {@link TalosAPIError.code}). */
  code: TalosErrorCode;
  /** Coarse failure bucket. */
  category: TalosErrorCategory;
  /** Whether the failure is transient and safe to retry. */
  retryable: boolean;
}

/**
 * Classify any thrown value into the stable taxonomy.
 *
 * - {@link TalosAPIError} instances are classified from their own `code` /
 *   `isRetryable`, so the taxonomy never disagrees with the thrown error.
 * - Generic `Error`s are inspected for abort/timeout signatures (matching the
 *   heuristic used by `classifyTransportError`) and otherwise fall back to the
 *   generic `api_error` / `api` / non-retryable bucket.
 *
 * Pure; never throws and never performs I/O.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof TalosAPIError) {
    return {
      code: error.code,
      category: codeToCategory(error.code),
      retryable: error.isRetryable,
    };
  }
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = (error as { message?: string } | null)?.message ?? "";
  const lower = `${name} ${message}`.toLowerCase();
  if (
    name === "AbortError" ||
    lower.includes("aborted") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return { code: "timeout_error", category: "timeout", retryable: true };
  }
  return { code: "api_error", category: "api", retryable: false };
}

/** A single redacted, JSON-safe frame in an error's cause chain. */
export interface RedactedCauseFrame {
  /** Error class name (e.g. `"TypeError"`, `"TalosTransportError"`). */
  name: string;
  /** Redacted + length-bounded error message. */
  message: string;
  /** Stable code when the frame is a typed Talos error, else omitted. */
  code?: string;
}

/** Maximum depth walked when building a cause chain (cycle + OOM guard). */
const MAX_CAUSE_DEPTH = 8;

/** Maximum bytes retained from a single cause message. */
const MAX_CAUSE_MESSAGE_BYTES = 256;

/**
 * Credential / secret substrings scrubbed from cause messages. Covers bearer
 * tokens, `sk-`/`tak_` API keys, and 56-char Stellar secret keys (`S` + 55
 * base32 chars). Intentionally narrow so useful context is preserved.
 */
const SECRET_TOKEN_PATTERN =
  /\b(Bearer\s+[A-Za-z0-9._\-=]+|sk-[A-Za-z0-9_\-]+|tak_[A-Za-z0-9]+|S[A-Z2-7]{55})\b/g;

/** Scrub obvious secrets from a message and cap its length. */
function redactMessage(raw: string): string {
  if (raw.length === 0) return raw;
  const scrubbed = raw.replace(SECRET_TOKEN_PATTERN, "[REDACTED]");
  return scrubbed.length <= MAX_CAUSE_MESSAGE_BYTES
    ? scrubbed
    : scrubbed.slice(0, MAX_CAUSE_MESSAGE_BYTES) + "…[truncated]";
}

/**
 * Build a redacted, bounded, JSON-safe cause chain for an error by walking
 * `error.cause` (the standard ES2022 `cause` property).
 *
 * - Bounded to {@link MAX_CAUSE_DEPTH} frames so a cyclic or very deep chain
 *   can never OOM or loop forever.
 * - Each frame is a plain `{ name, message, code? }` object with secrets
 *   scrubbed and message length capped, so the result serializes identically
 *   on Node and browser builds (no `inspect`/symbol reliance).
 * - Returns `undefined` when the error has no `cause`.
 */
export function buildCauseChain(error: unknown): RedactedCauseFrame[] | undefined {
  const frames: RedactedCauseFrame[] = [];
  let depth = 0;
  let current: unknown = (error as { cause?: unknown } | null)?.cause;
  while (current != null && depth < MAX_CAUSE_DEPTH) {
    const frame = current as { name?: string; message?: string; code?: string };
    const redacted: RedactedCauseFrame = {
      name:
        typeof frame?.name === "string" && frame.name.length > 0
          ? frame.name
          : "Error",
      message: redactMessage(
        typeof frame?.message === "string" ? frame.message : String(current),
      ),
    };
    if (typeof frame?.code === "string" && frame.code.length > 0) {
      redacted.code = frame.code;
    }
    frames.push(redacted);
    current = (current as { cause?: unknown } | null)?.cause;
    depth += 1;
  }
  return frames.length > 0 ? frames : undefined;
}

/**
 * A stable, JSON-serializable contract for an error, suitable for structured
 * logs, dashboards, and cross-runtime (Node/browser) transport. All fields are
 * plain primitives or arrays of plain objects; no symbols, no Node `inspect`.
 */
export interface ErrorContract {
  /** Error class name. */
  name: string;
  /** Stable string discriminator. */
  code: TalosErrorCode;
  /** Coarse failure bucket. */
  category: TalosErrorCategory;
  /** HTTP status, or `0` for non-HTTP failures. */
  status: number;
  /** Whether the failure is transient and safe to retry. */
  retryable: boolean;
  /** `x-request-id` for server-log correlation, when available. */
  requestId?: string;
  /** ISO 8601 timestamp captured when the error was constructed, when available. */
  timestamp?: string;
  /** API path the error occurred on, when available. */
  path?: string;
  /** Redacted, bounded cause chain, when the error wraps a cause. */
  causeChain?: ReadonlyArray<RedactedCauseFrame>;
  /** Taxonomy contract version ({@link ERROR_TAXONOMY_VERSION}). */
  taxonomyVersion: typeof ERROR_TAXONOMY_VERSION;
}

/**
 * Produce a stable, redacted {@link ErrorContract} for any thrown value.
 *
 * Combines {@link classifyError} with the structured fields of
 * {@link TalosAPIError} (status, requestId, timestamp, path) and a redacted
 * cause chain from {@link buildCauseChain}. The result is JSON-serializable on
 * both Node and browser builds. Pure; never throws.
 */
export function toErrorContract(error: unknown): ErrorContract {
  const classification = classifyError(error);
  const apiError = error instanceof TalosAPIError ? error : undefined;
  const causeChain = buildCauseChain(error);
  return {
    name: (error as { name?: string } | null)?.name ?? "Error",
    code: classification.code,
    category: classification.category,
    status: apiError?.status ?? 0,
    retryable: classification.retryable,
    ...(apiError?.requestId !== undefined ? { requestId: apiError.requestId } : {}),
    ...(apiError?.timestamp !== undefined ? { timestamp: apiError.timestamp } : {}),
    ...(apiError?.path !== undefined ? { path: apiError.path } : {}),
    ...(causeChain !== undefined ? { causeChain } : {}),
    taxonomyVersion: ERROR_TAXONOMY_VERSION,
  };
}
