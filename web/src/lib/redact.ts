const REDACTED = "[REDACTED]";

/**
 * Canonical sensitive field names (normalized: lowercased, `_`/`-` stripped).
 * Shared by payload redaction and public-URL query scrubbing so there is a
 * single source of truth for what never leaves the process in the clear.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "apisecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "secret",
  "password",
  "passwd",
  "cookie",
  "session",
  "sessionid",
  "seed",
  "mnemonic",
  "privatekey",
  "signingkey",
  "signature",
  "paymentproof",
  "proof",
  "xpayment",
  "xapikey",
  "bearer",
  // Issue acceptance: sensitive media must never be returned on public URLs.
  "media",
  "mediakey",
  "mediaurl",
  "content",
]);

/** Normalize a key for sensitive-field matching (case / punctuation insensitive). */
export function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** True when a query / object key names sensitive material. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeSensitiveKey(key));
}

/**
 * Redact sensitive query fields from a URL (absolute or relative).
 *
 * Safe params are preserved so operators still see useful context (filters,
 * cursors, page). Sensitive values are replaced with `[REDACTED]` rather than
 * dropping the key, so callers can tell a secret was present without seeing it.
 *
 * Behavior for edge cases:
 * - Missing / empty query → returned unchanged (aside from URL normalization).
 * - Malformed absolute URL → best-effort scrub of the `?...` suffix only.
 * - Duplicate keys → each sensitive occurrence is redacted independently.
 * - Hash / fragment → preserved as-is.
 */
export function redactSensitiveQueryFields(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }

  try {
    // Absolute URLs (http:, https:, and other schemes URL can parse).
    const url = new URL(input);
    return applyQueryRedaction(url).toString();
  } catch {
    // Relative paths / opaque strings: scrub only the query portion.
    return redactQuerySuffix(input);
  }
}

function applyQueryRedaction(url: URL): URL {
  if (![...url.searchParams.keys()].length) {
    return url;
  }

  const next = new URL(url.toString());
  const rebuilt = new URLSearchParams();

  // Iterate the raw query so we preserve insertion order and duplicates.
  for (const [key, value] of url.searchParams.entries()) {
    rebuilt.append(key, isSensitiveKey(key) ? REDACTED : value);
  }

  const qs = rebuilt.toString();
  next.search = qs ? `?${qs}` : "";
  return next;
}

function redactQuerySuffix(input: string): string {
  const hashIdx = input.indexOf("#");
  const hash = hashIdx >= 0 ? input.slice(hashIdx) : "";
  const withoutHash = hashIdx >= 0 ? input.slice(0, hashIdx) : input;

  const qIdx = withoutHash.indexOf("?");
  if (qIdx < 0) {
    return input;
  }

  const base = withoutHash.slice(0, qIdx);
  const rawQuery = withoutHash.slice(qIdx + 1);
  if (!rawQuery) {
    return `${base}${hash}`;
  }

  try {
    const params = new URLSearchParams(rawQuery);
    const rebuilt = new URLSearchParams();
    for (const [key, value] of params.entries()) {
      rebuilt.append(key, isSensitiveKey(key) ? REDACTED : value);
    }
    const qs = rebuilt.toString();
    return qs ? `${base}?${qs}${hash}` : `${base}${hash}`;
  } catch {
    // Malformed query we cannot parse — fail closed: drop the query entirely
    // rather than echo secrets. Keep the path/base and fragment.
    return `${base}${hash}`;
  }
}

/**
 * Recursively redacts sensitive keys from an object or array.
 * Retains non-secret context by only replacing the values of sensitive keys.
 * String values that look like URLs also have sensitive query fields scrubbed.
 * Handles nested objects, arrays, and circular references safely.
 */
export function redactPayload<T>(payload: T, seen = new WeakSet()): T {
  // Primitives and nulls are returned as-is (strings may still need URL scrub).
  if (payload === null || typeof payload !== "object") {
    if (typeof payload === "string") {
      return scrubStringValue(payload) as T;
    }
    return payload;
  }

  // Handle circular references
  if (seen.has(payload as object)) {
    return "[CIRCULAR]" as T;
  }
  seen.add(payload as object);

  if (Array.isArray(payload)) {
    return payload.map((item) => redactPayload(item, seen)) as T;
  }

  const redactedObj: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      redactedObj[key] = REDACTED;
    } else {
      redactedObj[key] = redactPayload(value, seen);
    }
  }

  return redactedObj as T;
}

function scrubStringValue(value: string): string {
  // Only touch strings that clearly carry a query string — avoids rewriting
  // arbitrary prose that happens to contain a `?`.
  if (!value.includes("?") || value.length > 8_192) {
    return value;
  }
  if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("?")) {
    return redactSensitiveQueryFields(value);
  }
  // "not a URL?token=secret" style (matches sentry-scrub fail-closed fixture).
  if (/\?[^=&\s]+=/.test(value)) {
    return redactSensitiveQueryFields(value);
  }
  return value;
}

export { REDACTED };
