const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "signature",
  "paymentproof",
]);

/**
 * Recursively redacts sensitive keys from an object or array.
 * Retains non-secret context by only replacing the values of sensitive keys.
 * Handles nested objects, arrays, and circular references safely.
 */
export function redactPayload<T>(payload: T, seen = new WeakSet()): T {
  // Primitives and nulls are returned as-is
  if (payload === null || typeof payload !== "object") {
    return payload;
  }

  // Handle circular references
  if (seen.has(payload)) {
    return "[CIRCULAR]" as any;
  }
  seen.add(payload);

  if (Array.isArray(payload)) {
    return payload.map((item) => redactPayload(item, seen)) as any;
  }

  const redactedObj: Record<string, any> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      redactedObj[key] = REDACTED;
    } else {
      redactedObj[key] = redactPayload(value, seen);
    }
  }

  return redactedObj as T;
}
