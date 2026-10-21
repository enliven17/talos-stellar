/**
 * Build the canonical message an agent owner signs to prove wallet ownership
 * over a `resource` (e.g. `api-keys`, `purchases`) for a given HTTP method.
 * The timestamp binds the signature to a short validity window so a captured
 * proof cannot be replayed indefinitely.
 */
export function createOwnerProofMessage(
  talosId: string,
  resource: string,
  method: string,
  timestamp = Date.now(),
): string {
  return `talos:${talosId}:${resource}:${method}:${timestamp}`;
}

export function createApiKeyOwnerMessage(
  talosId: string,
  method: string,
  timestamp = Date.now(),
): string {
  return createOwnerProofMessage(talosId, "api-keys", method, timestamp);
}
