export function createApiKeyOwnerMessage(talosId: string, method: string, timestamp = Date.now()): string {
  return `talos:${talosId}:api-keys:${method}:${timestamp}`;
}
