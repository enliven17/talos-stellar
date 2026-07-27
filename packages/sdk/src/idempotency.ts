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
