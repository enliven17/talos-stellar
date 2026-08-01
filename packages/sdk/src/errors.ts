/**
 * Stable, typed SDK error hierarchy for the Talos Protocol.
 *
 * All errors thrown by {@link TalosClient} extend {@link TalosAPIError}, so
 * existing `try { } catch (e) { if (e instanceof TalosAPIError) … }` blocks
 * continue to work unchanged. New typed subclasses surface actionable
 * information (parsed validation issues, parsed x402 challenge, retry hints,
 * rate-limit counters, request-id, sanitized response headers) for callers
 * that want to react to specific failure modes.
 *
 * Privacy / safety guarantees:
 *   - Bodies are sanitized: parsed JSON is truncated to 1024 bytes; raw text
 *     is reduced to the same cap; common secret-like fields (`token`,
 *     `authorization`, `secret`, `apiKey`) are redacted in `body`/`data`.
 *   - Headers are stored with lowercased keys and only contain the safe set
 *     (`x-request-id`, `retry-after`, `www-authenticate`, `x-ratelimit-*`).
 *   - No request bodies (which may contain signatures, secrets, amounts) are
 *     ever surfaced through errors.
 *
 * @module errors
 */

/** Stable string discriminator for `switch`-style error handling. */
export type TalosErrorCode =
  | "validation_error"
  | "authentication_error"
  | "forbidden"
  | "not_found_error"
  | "conflict_error"
  | "payment_error"
  | "rate_limit_error"
  | "server_error"
  | "transport_error"
  | "timeout_error"
  | "api_error";

/**
 * Maximum number of bytes retained from a response body when building an
 * error. Bounded so that error logs / propagations stay small and predictable.
 */
export const MAX_BODY_BYTES = 1024;

/**
 * Maximum number of bytes retained from a serialized `data` payload when
 * surfaced via {@link TalosAPIError.dataForLog}. Mirrors {@link MAX_BODY_BYTES}
 * to keep error logs bounded in both directions.
 */
export const MAX_DATA_BYTES = 4096;

/**
 * Names of fields whose values potentially contain credentials or other
 * sensitive material. We redact them in the surfaced error body and `data`.
 */
const SENSITIVE_FIELD_PATTERN = /^(token|authorization|secret|api[_-]?key|password|cookie|signature|message|nonce|hash)$/i;

/**
 * Options accepted by every TalosAPIError subclass via the 4th constructor
 * argument. All fields are optional and additive.
 */
export interface TalosAPIErrorOptions {
  /** Override the default error message (used to preserve raw network message). */
  message?: string;
  /** Stable string discriminator (set automatically by subclasses). */
  code?: TalosErrorCode;
  /** Whether the failure is transient and safe to retry. */
  isRetryable?: boolean;
  /** Server-supplied retry hint (already normalized to milliseconds). */
  retryAfterMs?: number;
  /** Snapshot of relevant response headers (lowercased keys). */
  headers?: Record<string, string>;
  /** `x-request-id` for correlation with server logs. */
  requestId?: string;
  /** Parsed response body (JSON-decoded, sanitized). */
  data?: unknown;
  /** Original cause (transport / parse failure). */
  cause?: unknown;
  /** ISO 8601 timestamp captured when the error was constructed. */
  timestamp?: string;
}

/**
 * Sanitize a response body. Returns `{ body, data }` where:
 *   - `body` is a JSON-safe string with sensitive fields redacted and size
 *     capped at {@link MAX_BODY_BYTES}.
 *   - `data` is the parsed JSON object (or `undefined` if not parseable).
 *
 * Non-JSON bodies (HTML error pages, proxy fallbacks, plain text) are
 * truncated and returned as a single-line string.
 */
export function sanitizeBody(raw: string | undefined | null): {
  body: string;
  data?: unknown;
} {
  if (raw == null || raw.length === 0) {
    return { body: "" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const safe = redactSecrets(parsed);
    const compact = JSON.stringify(safe);
    return { body: truncate(compact), data: safe };
  } catch {
    // Not JSON — collapse to a single line, truncate.
    const single = raw.replace(/\s+/g, " ").trim();
    return { body: truncate(single) };
  }
}

/** Truncate a string to MAX_BODY_BYTES, suffixing with an ellipsis marker. */
function truncate(s: string): string {
  if (s.length <= MAX_BODY_BYTES) return s;
  return s.slice(0, MAX_BODY_BYTES) + "…[truncated]";
}

/**
 * Recursively redact sensitive fields inside a parsed JSON value. Mutates a
 * copy so the original (if any) is not aliased. Public callers should use
 * this single-arg form; cycle detection is handled internally.
 */
export function redactSecrets(value: unknown): unknown {
  return redactSecretsInternal(value, new WeakSet<object>());
}

function redactSecretsInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSecretsInternal(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_FIELD_PATTERN.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSecretsInternal(v, seen);
    }
  }
  return out;
}

/** Pull a small, safe set of headers off a `Headers` object. */
export function snapshotHeaders(headers: Headers | Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const get = (key: string): string | null => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(key);
    }
    const rec = headers as Record<string, string>;
    return rec[key.toLowerCase()] ?? rec[key] ?? null;
  };
  const SAFE_HEADER_KEYS = [
    "x-request-id",
    "retry-after",
    "www-authenticate",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ];
  for (const key of SAFE_HEADER_KEYS) {
    const v = get(key);
    if (v != null) out[key] = v;
  }
  return out;
}

/**
 * Parse `Retry-After` header to milliseconds. Accepts:
 *   - Plain seconds (e.g. `60`)
 *   - HTTP date (e.g. `Wed, 21 Oct 2015 07:28:00 GMT`)
 *
 * Returns `undefined` if the value cannot be parsed.
 */
export function parseRetryAfter(value: string | undefined | null, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = parseFloat(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - nowMs);
  }
  return undefined;
}

/**
 * Parse an `x402` `WWW-Authenticate` header value.
 * Format: `x402 price="0.50", payee="G…", token="USDC", network="stellar:testnet"`
 *
 * Requires `price` and `payee` to be present — partial challenges are rejected
 * so callers cannot accidentally feed `NaN` into `parseFloat(undefined)`.
 */
export function parseX402Challenge(header: string | undefined | null): Record<string, string> | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed.startsWith("x402")) return undefined;
  const rest = trimmed.slice(4).replace(/^[ ,]+/, "");
  const out: Record<string, string> = {};
  // Split on `, ` (comma + space) outside of quotes.
  const parts = rest.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const rawKey = part.slice(0, eq).trim();
    let rawVal = part.slice(eq + 1).trim();
    if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
      rawVal = rawVal.slice(1, -1);
    }
    if (rawKey) out[rawKey] = rawVal;
  }
  if (!out.price || !out.payee) return undefined;
  return out;
}

/**
 * Base class for all SDK errors. Preserves the legacy
 * `(status, body, path)` constructor signature so existing catch blocks and
 * import sites keep working.
 *
 * New in this version:
 *   - `code`: stable string discriminator (subclasses set this).
 *   - `isRetryable`: hint to callers whether a retry is safe.
 *   - `retryAfterMs`: server-supplied retry delay.
 *   - `requestId`: `x-request-id` for log correlation.
 *   - `headers`: subset of safe response headers.
 *   - `data`: parsed JSON body (sanitized, optional).
 *   - `cause`: original error if this wraps a transport/parse failure.
 *   - `timestamp`: ISO 8601 string captured at construction time.
 */
export class TalosAPIError extends Error {
  public code: TalosErrorCode = "api_error";
  public isRetryable: boolean = false;
  public readonly retryAfterMs?: number;
  public readonly requestId?: string;
  public readonly headers: Record<string, string>;
  public readonly data?: unknown;
  public readonly cause?: unknown;
  public readonly timestamp: string;

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
    options: TalosAPIErrorOptions = {},
  ) {
    const message = options.message ?? `Talos API error ${status} on ${path}: ${body}`;
    super(message);
    this.name = "TalosAPIError";
    this.code = options.code ?? "api_error";
    this.isRetryable = options.isRetryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
    this.headers = options.headers ?? {};
    // Apply the same redaction + size cap to `data` that `body` already
    // gets via `sanitizeBody`. This way direct access (`error.data`) and the
    // `toJSON()` / `dataForLog()` paths agree: no raw hostile 5xx payload
    // ever leaks through.
    this.data = sanitizeDataForInstance(options.data);
    this.cause = options.cause;
    this.timestamp = options.timestamp ?? new Date().toISOString();
  }

  /**
   * Compact JSON-safe representation suitable for logging. `body` is omitted
   * (already capped at MAX_BODY_BYTES on the property) but `data` is **NOT**
   * included — callers that want the parsed payload should access `error.data`
   * directly so they apply their own size limits. This prevents hostile 5xx
   * bodies from OOM'ing structured log sinks.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      path: this.path,
      isRetryable: this.isRetryable,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      timestamp: this.timestamp,
    };
  }

  /**
   * Bounded helper for safely surfacing `data` to structured log sinks.
   * Returns the parsed JSON object when it stringifies to <= {@link MAX_DATA_BYTES},
   * otherwise `undefined`. Prefer this over piping `error.data` directly when
   * the payload source (5xx error body, proxy fallback) is untrusted.
   */
  dataForLog(): unknown {
    if (this.data === undefined) return undefined;
    try {
      const json = JSON.stringify(this.data);
      if (json.length <= MAX_DATA_BYTES) return this.data;
      return undefined;
    } catch {
      return undefined;
    }
  }
}

/** 400 — request body or parameters failed validation. */
export class TalosValidationError extends TalosAPIError {
  public readonly issues: string[];
  constructor(
    status: number,
    body: string,
    path: string,
    issues: string[] = [],
    options: TalosAPIErrorOptions = {},
  ) {
    super(status, body, path, { ...options, code: "validation_error" });
    this.name = "TalosValidationError";
    this.issues = issues;
  }
}

/**
 * 401 — credentials missing or malformed.
 * Distinct from {@link TalosForbiddenError}, which represents credentials
 * being rejected (403). Keeping the split prevents `instanceof
 * TalosAuthenticationError` from silently matching 403 responses.
 */
export class TalosAuthenticationError extends TalosAPIError {
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, { ...options, code: "authentication_error" });
    this.name = "TalosAuthenticationError";
  }
}

/** 403 — credentials supplied but rejected. */
export class TalosForbiddenError extends TalosAPIError {
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, { ...options, code: "forbidden" });
    this.name = "TalosForbiddenError";
  }
}

/** 404 — resource not found. */
export class TalosNotFoundError extends TalosAPIError {
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, options);
    this.name = "TalosNotFoundError";
    // Subclasses can override code via options, but we set the default.
    if (this.code === "api_error") this.code = "not_found_error";
  }
}

/** 409 — state conflict (lease, idempotency key, duplicate request). */
export class TalosConflictError extends TalosAPIError {
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, options);
    this.name = "TalosConflictError";
    if (this.code === "api_error") this.code = "conflict_error";
  }
}

/** 402 — payment required (x402 challenge) or generic payment failure. */
export class TalosPaymentError extends TalosAPIError {
  public readonly challenge?: Record<string, string>;
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, { ...options, code: "payment_error" });
    this.name = "TalosPaymentError";
    this.challenge = parseX402Challenge(options.headers?.["www-authenticate"]);
  }
}

/** 429 — rate limited. */
export class TalosRateLimitError extends TalosAPIError {
  public readonly limit?: number;
  public readonly remaining?: number;
  public readonly resetAt?: number;
  constructor(
    status: number,
    body: string,
    path: string,
    options: TalosAPIErrorOptions = {},
  ) {
    super(status, body, path, {
      ...options,
      code: "rate_limit_error",
      isRetryable: true,
    });
    this.name = "TalosRateLimitError";
    const limitHeader = options.headers?.["x-ratelimit-limit"];
    const remainingHeader = options.headers?.["x-ratelimit-remaining"];
    const resetHeader = options.headers?.["x-ratelimit-reset"];
    if (limitHeader != null) this.limit = Number(limitHeader);
    if (remainingHeader != null) this.remaining = Number(remainingHeader);
    if (resetHeader != null) this.resetAt = Number(resetHeader) * 1000; // server emits seconds
  }
}

/** 5xx — server returned a non-retryable error (use ServerRetryableError for transient 5xx). */
export class TalosServerError extends TalosAPIError {
  constructor(status: number, body: string, path: string, options: TalosAPIErrorOptions = {}) {
    super(status, body, path, options);
    this.name = "TalosServerError";
    if (this.code === "api_error") this.code = "server_error";
  }
}

/**
 * 502/503/504 — transient server failure, safe to retry with backoff.
 * Surfaces as the same type as {@link TalosServerError} but with
 * `isRetryable = true`.
 */
export class TalosServerRetryableError extends TalosServerError {
  constructor(
    status: number,
    body: string,
    path: string,
    options: TalosAPIErrorOptions = {},
  ) {
    super(status, body, path, { ...options, isRetryable: true });
    this.name = "TalosServerRetryableError";
  }
}

/** Status `0` — network/transport failure (DNS, ECONNREFUSED, EOS, etc.). */
export class TalosTransportError extends TalosAPIError {
  constructor(
    status: 0,
    body: string,
    path: string,
    options: TalosAPIErrorOptions = {},
  ) {
    super(status, body, path, {
      ...options,
      code: "transport_error",
      isRetryable: true,
    });
    this.name = "TalosTransportError";
  }
}

/** Status `0` — timeout or abort. */
export class TalosTimeoutError extends TalosAPIError {
  constructor(
    status: 0,
    body: string,
    path: string,
    options: TalosAPIErrorOptions = {},
  ) {
    super(status, body, path, {
      ...options,
      code: "timeout_error",
      isRetryable: true,
    });
    this.name = "TalosTimeoutError";
  }
}

/**
 * Sanitize an `options.data` value into a privacy-safe shape:
 *   - `undefined`/`null` pass through as `undefined`.
 *   - Non-JSON-serializable values return `undefined`.
 *   - Strings, numbers, booleans pass through if their textual length
 *     is `<= MAX_DATA_BYTES`.
 *   - Objects run through {@link redactSecrets} (deep), then get checked
 *     against `MAX_DATA_BYTES` after a dry-run `JSON.stringify` — if too
 *     big, the field is dropped rather than risk an OOM downstream.
 *
 * Kept internal because the consumer does not need to call it directly;
 * the {@link TalosAPIError} constructor applies it.
 */
function sanitizeDataForInstance(input: unknown): unknown {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object") {
    return typeof input === "string" && input.length > MAX_DATA_BYTES
      ? undefined
      : input;
  }
  const redacted = redactSecrets(input);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized.length > MAX_DATA_BYTES) return undefined;
    return redacted;
  } catch {
    return undefined;
  }
}

/**
 * Build the right {@link TalosAPIError} subclass for a given HTTP response.
 * Pure function — kept small so tests can exercise it directly.
 */
export function errorFromResponse(
  status: number,
  path: string,
  rawBody: string,
  headers: Headers | Record<string, string>,
): TalosAPIError {
  const { body, data } = sanitizeBody(rawBody);
  const safeHeaders = snapshotHeaders(headers);
  const requestId = safeHeaders["x-request-id"];
  const issues = Array.isArray((data as { issues?: unknown[] } | undefined)?.issues)
    ? (((data as { issues: unknown[] }).issues as unknown[]) as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  switch (status) {
    case 400:
      return new TalosValidationError(status, body, path, issues, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 401:
      return new TalosAuthenticationError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 402:
      return new TalosPaymentError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 403:
      return new TalosForbiddenError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 404:
      return new TalosNotFoundError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 409:
      return new TalosConflictError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    case 429:
      return new TalosRateLimitError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
        retryAfterMs: parseRetryAfter(safeHeaders["retry-after"]),
      });
    case 502:
    case 503:
    case 504:
      return new TalosServerRetryableError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
    default:
      if (status >= 500) {
        return new TalosServerError(status, body, path, {
          headers: safeHeaders,
          requestId,
          data,
        });
      }
      return new TalosAPIError(status, body, path, {
        headers: safeHeaders,
        requestId,
        data,
      });
  }
}

/**
 * Classify a raw error thrown by `fetch` (or its underlying transport) into
 * the appropriate typed error. The original message string is preserved on
 * the `message` property so legacy `rejects.toThrow("…")` patterns keep
 * working.
 */
export function classifyTransportError(
  cause: unknown,
  path: string,
): TalosTransportError | TalosTimeoutError {
  const name = (cause as { name?: string } | null)?.name ?? "";
  const message = (cause as { message?: string } | null)?.message ?? String(cause ?? "");
  // AbortError covers timeouts, manual cancels, and signal-driven aborts.
  if (name === "AbortError" || message.toLowerCase().includes("aborted")) {
    return new TalosTimeoutError(0, truncate(message), path, { message });
  }
  if (
    name === "TimeoutError" ||
    message.toLowerCase().includes("timeout") ||
    message.toLowerCase().includes("timed out")
  ) {
    return new TalosTimeoutError(0, truncate(message), path, { message });
  }
  const safeBody = truncate(message.replace(/\s+/g, " ").trim());
  return new TalosTransportError(0, safeBody, path, { message, cause });
}
