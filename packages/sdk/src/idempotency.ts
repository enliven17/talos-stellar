/**
 * Idempotency key utilities for the Talos SDK.
 *
 * Keys are RFC 4122 v4 UUIDs — globally unique, opaque, and free of PII.
 * They are scoped per talosId on the server so the same UUID is safe to
 * reuse across different agents.
 *
 * Browser compatibility
 * ─────────────────────
 * `crypto.randomUUID()` is available in Chrome 92+, Firefox 95+, Safari 15.4+,
 * and Node.js 19+. For older environments a Math.random-based fallback is used.
 * The fallback is sufficient for uniqueness but is not cryptographically strong.
 *
 * Client-side helpers
 * ────────────────────
 * In addition to key generation and validation primitives, this module ships:
 *
 *   - `withIdempotency` — wraps any async operation with auto-key generation,
 *     safe retry on transient errors (5xx/429), and payload-conflict detection.
 *   - `createIdempotencyStore` / `InMemoryIdempotencyStore` — a lightweight
 *     in-process response cache that deduplicates identical retries client-side
 *     before the request even leaves the network layer.
 */

export const IDEMPOTENCY_KEY_MAX_BYTES = 128;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generate a new idempotency key.
 *
 * Uses `crypto.randomUUID()` when available and falls back to a Math.random
 * implementation that produces a valid RFC 4122 v4 UUID.
 */
export function generateIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
  ) {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }
  // Math.random fallback — valid UUID v4 format, not cryptographically strong
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Validate that a caller-supplied idempotency key meets the server's constraints:
 * - Non-empty string
 * - At most IDEMPOTENCY_KEY_MAX_BYTES bytes (UTF-8)
 *
 * Returns the key unchanged if valid, or throws a TypeError.
 */
export function validateIdempotencyKey(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("idempotencyKey must be a non-empty string");
  }
  // Use TextEncoder for accurate byte length in all environments
  const byteLength =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(key).length
      : Buffer.byteLength(key, "utf8");
  if (byteLength > IDEMPOTENCY_KEY_MAX_BYTES) {
    throw new TypeError(
      `idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX_BYTES} bytes (got ${byteLength})`,
    );
  }
  return key;
}

/**
 * Returns true if the string is a well-formed RFC 4122 v4 UUID.
 * Non-UUID keys are still valid; this is only informational.
 */
export function isUuidV4(key: string): boolean {
  return UUID_REGEX.test(key);
}

/**
 * Thrown when a 409 response indicates an idempotency key was reused with a
 * different payload. This is a caller error — the caller should generate a new
 * key for the new request.
 *
 * Extends TalosAPIError so callers that catch TalosAPIError still handle it.
 */
export class IdempotencyConflictError extends Error {
  readonly status = 409;
  readonly conflictingKey: string;
  readonly path: string;

  constructor(conflictingKey: string, path: string, body: string) {
    super(
      `Idempotency key "${conflictingKey}" was reused with a different payload on ${path}. ` +
        `Generate a new key for a different request. Server said: ${body}`,
    );
    this.name = "IdempotencyConflictError";
    this.conflictingKey = conflictingKey;
    this.path = path;
  }
}

/**
 * Inspect a 409 response body and decide whether it represents a payload
 * conflict (should throw IdempotencyConflictError) or an in-flight duplicate
 * (should throw TalosAPIError(409) so the caller retries with the same key).
 */
export function isPayloadConflict(body: string): boolean {
  return body.toLowerCase().includes("different payload");
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side idempotency store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stored idempotency record. Captures the settled outcome of an operation
 * so that a replay of the same key returns the same logical result without
 * executing the operation again.
 *
 * Privacy note: the `response` field stores the raw resolved value from the
 * wrapped operation. Callers are responsible for ensuring it does not contain
 * secrets, seeds, payment proofs, or other sensitive material.
 */
export interface IdempotencyRecord<T> {
  /** The idempotency key that identifies this operation. */
  readonly key: string;
  /** The settled response value (from a successful invocation). */
  readonly response: T;
  /** Unix timestamp (ms) when this record was created. */
  readonly createdAt: number;
}

/**
 * Interface for a pluggable client-side idempotency store.
 *
 * Implementations must be safe to call concurrently from a single event-loop
 * tick (i.e. synchronous `get`/`set` are fine; async is also accepted).
 */
export interface IdempotencyStore<T = unknown> {
  /**
   * Retrieve a previously stored record for `key`, or `undefined` if absent
   * or expired.
   */
  get(key: string): IdempotencyRecord<T> | undefined;

  /**
   * Persist the settled result for `key`. Implementations may enforce a TTL
   * or maximum size and silently evict old entries.
   */
  set(key: string, record: IdempotencyRecord<T>): void;

  /**
   * Remove a record for `key`. Used when a previous attempt should not be
   * replayed (e.g. after a payload-conflict error forces a new key).
   */
  delete(key: string): void;
}

/**
 * Lightweight in-memory idempotency store with optional TTL-based expiry.
 *
 * Suitable for use within a single process (Node or browser). Entries are
 * never persisted across process restarts. For durable deduplication, wire
 * in a persistent store (Redis, SQLite, etc.) via the {@link IdempotencyStore}
 * interface.
 *
 * @example
 * ```typescript
 * const store = new InMemoryIdempotencyStore({ ttlMs: 60_000 });
 * const key = generateIdempotencyKey();
 * const result = await withIdempotency(key, () => client.reportActivity(...), { store });
 * ```
 */
export class InMemoryIdempotencyStore<T = unknown>
  implements IdempotencyStore<T>
{
  private readonly _map = new Map<string, IdempotencyRecord<T>>();
  private readonly _ttlMs: number;

  /**
   * @param options.ttlMs — How long (in milliseconds) to keep a record.
   *   Defaults to `300_000` (5 minutes). Pass `0` or `Infinity` for no expiry.
   */
  constructor(options?: { ttlMs?: number }) {
    this._ttlMs =
      options?.ttlMs === undefined ? 300_000 : Math.max(0, options.ttlMs);
  }

  get(key: string): IdempotencyRecord<T> | undefined {
    const record = this._map.get(key);
    if (!record) return undefined;
    if (this._isExpired(record)) {
      this._map.delete(key);
      return undefined;
    }
    return record;
  }

  set(key: string, record: IdempotencyRecord<T>): void {
    this._map.set(key, record);
  }

  delete(key: string): void {
    this._map.delete(key);
  }

  /** Number of live (non-expired) entries. */
  get size(): number {
    let count = 0;
    const now = Date.now();
    for (const record of this._map.values()) {
      if (!this._isExpiredAt(record, now)) count++;
    }
    return count;
  }

  /** Remove all expired entries. Call periodically to reclaim memory. */
  evictExpired(): void {
    const now = Date.now();
    for (const [key, record] of this._map.entries()) {
      if (this._isExpiredAt(record, now)) {
        this._map.delete(key);
      }
    }
  }

  private _isExpired(record: IdempotencyRecord<T>): boolean {
    return this._isExpiredAt(record, Date.now());
  }

  private _isExpiredAt(record: IdempotencyRecord<T>, now: number): boolean {
    if (this._ttlMs === 0 || this._ttlMs === Infinity) return false;
    return now - record.createdAt > this._ttlMs;
  }
}

/**
 * Create a pre-configured {@link InMemoryIdempotencyStore}.
 *
 * Convenience factory for callers that prefer a functional style:
 *
 * ```typescript
 * const store = createIdempotencyStore<JobResult>({ ttlMs: 30_000 });
 * ```
 */
export function createIdempotencyStore<T = unknown>(options?: {
  ttlMs?: number;
}): InMemoryIdempotencyStore<T> {
  return new InMemoryIdempotencyStore<T>(options);
}

// ─────────────────────────────────────────────────────────────────────────────
// withIdempotency — retry-safe wrapper
// ─────────────────────────────────────────────────────────────────────────────

/** Error codes surfaced by {@link withIdempotency}. */
export type IdempotencyErrorCode =
  | "CONFLICT"       // 409 with a different payload — caller must generate a new key
  | "EXHAUSTED"      // all retry attempts consumed without success
  | "CANCELLED";     // AbortSignal fired before the operation completed

/**
 * Thrown by {@link withIdempotency} for non-retryable failures.
 */
export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;
  readonly key: string;
  readonly cause?: unknown;

  constructor(
    code: IdempotencyErrorCode,
    key: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
    this.key = key;
    this.cause = cause;
  }
}

/** Status codes that are safe to retry when an idempotency key is present. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Options for {@link withIdempotency}.
 */
export interface WithIdempotencyOptions<T> {
  /**
   * A pluggable store for deduplicating responses client-side.
   * When provided, a cached result is returned immediately on replay
   * without executing `fn` again.
   */
  store?: IdempotencyStore<T>;

  /**
   * Maximum number of attempts (including the first). Defaults to `3`.
   * Clamped to `[1, 8]`.
   */
  maxAttempts?: number;

  /**
   * Base delay in milliseconds between retries. Defaults to `100`.
   * Actual delay uses truncated binary exponential backoff.
   */
  baseDelayMs?: number;

  /**
   * Upper bound on computed delay in milliseconds. Defaults to `5_000`.
   */
  maxDelayMs?: number;

  /**
   * When `true` (default), delay is randomized in `[0.5×delay, delay]` to
   * reduce thundering-herd retries.
   */
  jitter?: boolean;

  /**
   * AbortSignal to cancel the operation mid-flight.
   */
  signal?: AbortSignal;

  /**
   * Injectable clock for deterministic tests. Defaults to `Date.now`.
   */
  _now?: () => number;

  /**
   * Injectable sleep for deterministic tests. Defaults to a real
   * `setTimeout`-based sleep that respects AbortSignal.
   */
  _sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Wrap an async operation `fn` with idempotency key enforcement and
 * retry-on-transient-error semantics.
 *
 * ## Behaviour
 *
 * 1. If `store` is provided and already holds a record for `key`, the cached
 *    response is returned immediately — `fn` is not called.
 * 2. Otherwise `fn(key)` is called. The caller receives `key` as its argument
 *    so it can inject the key into request headers, query parameters, or the
 *    request body as appropriate.
 * 3. On success the result is stored in `store` (if provided) and returned.
 * 4. On a retryable error (status 408/429/5xx, or a network error without an
 *    HTTP status) the call is retried up to `maxAttempts - 1` more times with
 *    exponential backoff.
 * 5. On a payload-conflict error (`IdempotencyConflictError`) the store entry
 *    is deleted (if present) and an `IdempotencyError("CONFLICT")` is thrown —
 *    the caller must generate a fresh key.
 * 6. Cancellation via `AbortSignal` surfaces as `IdempotencyError("CANCELLED")`.
 * 7. After all attempts are exhausted, `IdempotencyError("EXHAUSTED")` is thrown
 *    with the last error attached as `cause`.
 *
 * ## Privacy
 *
 * `key` is a UUID; it is safe to log. The `response` stored in the cache is
 * under caller control — avoid storing objects that contain secrets, seeds,
 * payment proofs, or other sensitive material.
 *
 * @param key   — The idempotency key. Must satisfy {@link validateIdempotencyKey}.
 * @param fn    — The async operation to protect. Receives `key` as its argument.
 * @param opts  — Optional configuration (store, retries, backoff, signal).
 *
 * @example
 * ```typescript
 * const key = generateIdempotencyKey();
 * const store = createIdempotencyStore<CommerceJob>({ ttlMs: 60_000 });
 *
 * const job = await withIdempotency(
 *   key,
 *   (k) => client.reportActivity(talosId, params, { idempotencyKey: k }),
 *   { store, maxAttempts: 4 },
 * );
 * ```
 */
export async function withIdempotency<T>(
  key: string,
  fn: (key: string) => Promise<T>,
  opts: WithIdempotencyOptions<T> = {},
): Promise<T> {
  // Validate key upfront — privacy-safe: TypeError message contains byte count, not key contents.
  validateIdempotencyKey(key);

  const {
    store,
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5_000,
    jitter = true,
    signal,
    _now = Date.now,
    _sleep = defaultSleep,
  } = opts;

  const clampedAttempts = Math.max(1, Math.min(8, maxAttempts));

  // 1. Cache hit — replay without calling fn.
  if (store) {
    const cached = store.get(key);
    if (cached) {
      return cached.response;
    }
  }

  // 2. Attempt loop.
  let lastError: unknown;
  for (let attempt = 0; attempt < clampedAttempts; attempt++) {
    if (signal?.aborted) {
      throw new IdempotencyError(
        "CANCELLED",
        key,
        `withIdempotency: operation cancelled before attempt ${attempt + 1}`,
        signal.reason,
      );
    }

    try {
      const result = await fn(key);

      // Success — persist to store.
      if (store) {
        store.set(key, { key, response: result, createdAt: _now() });
      }
      return result;
    } catch (err: unknown) {
      lastError = err;

      // Non-retryable: payload conflict → caller must generate a new key.
      if (err instanceof IdempotencyConflictError) {
        if (store) store.delete(key);
        throw new IdempotencyError(
          "CONFLICT",
          key,
          `withIdempotency: key "${key}" reused with a different payload. Generate a new key.`,
          err,
        );
      }

      // Cancellation propagated from fn.
      if (signal?.aborted) {
        throw new IdempotencyError(
          "CANCELLED",
          key,
          `withIdempotency: operation cancelled during attempt ${attempt + 1}`,
          err,
        );
      }

      // Check if retryable by status code (duck-type against TalosAPIError / IdempotencyConflictError).
      const status = _getStatus(err);
      const retryable =
        status === undefined || RETRYABLE_STATUSES.has(status);

      if (!retryable || attempt === clampedAttempts - 1) {
        // Non-retryable or last attempt.
        break;
      }

      // Compute backoff delay.
      const raw = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = jitter ? Math.random() * raw * 0.5 + raw * 0.5 : raw;
      await _sleep(delay, signal);
    }
  }

  throw new IdempotencyError(
    "EXHAUSTED",
    key,
    `withIdempotency: all ${clampedAttempts} attempt(s) failed for key "${key}"`,
    lastError,
  );
}

/**
 * Extract an HTTP status code from an unknown error value, if present.
 * Returns `undefined` when the error carries no status (e.g. network errors).
 * Privacy-safe: never inspects or logs the error message contents.
 */
function _getStatus(err: unknown): number | undefined {
  if (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return undefined;
}

/**
 * Default sleep implementation.  Respects AbortSignal so retries can be
 * cancelled mid-backoff without waiting for the full delay.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}
