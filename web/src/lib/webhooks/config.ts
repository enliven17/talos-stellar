/**
 * Webhook delivery system configuration.
 *
 * All values can be overridden via environment variables.
 * The system defaults to disabled (delivery not active) until explicitly
 * configured, preserving existing behavior.
 */

// ─── Feature flag ────────────────────────────────────────────────

/** Master enable switch. When false, no webhook deliveries are attempted. */
export function isWebhookDeliveryEnabled(): boolean {
  return (
    process.env.WEBHOOK_DELIVERY_ENABLED === "true" ||
    process.env.WEBHOOK_DELIVERY_ENABLED === "1"
  );
}

// ─── Delivery settings ───────────────────────────────────────────

/** Default maximum delivery attempts before moving to dead-letter. */
export const DEFAULT_MAX_ATTEMPTS = Number(
  process.env.WEBHOOK_DEFAULT_MAX_ATTEMPTS ?? 5,
);

/** Base delay (ms) for exponential backoff: delay = base * 2^attempt */
export const BACKOFF_BASE_MS = Number(
  process.env.WEBHOOK_BACKOFF_BASE_MS ?? 1_000,
);

/** Maximum backoff delay cap (ms). */
export const BACKOFF_MAX_MS = Number(
  process.env.WEBHOOK_BACKOFF_MAX_MS ?? 60_000,
);

/** HTTP request timeout (ms) for outbound webhook delivery. */
export const DELIVERY_TIMEOUT_MS = Number(
  process.env.WEBHOOK_DELIVERY_TIMEOUT_MS ?? 10_000,
);

/** Maximum payload body size (bytes) to accept when creating deliveries. */
export const MAX_PAYLOAD_BYTES = Number(
  process.env.WEBHOOK_MAX_PAYLOAD_BYTES ?? 64_000,
);

// ─── Lease settings (same pattern as commerce jobs) ──────────────

/** Default lease TTL (seconds) for a claimed delivery. */
export const DEFAULT_LEASE_TTL_SECONDS = Number(
  process.env.WEBHOOK_LEASE_TTL_SECONDS ?? 300,
);

/** Heartbeat extends lease by this many seconds. */
export const HEARTBEAT_EXTEND_SECONDS = Number(
  process.env.WEBHOOK_HEARTBEAT_EXTEND_SECONDS ?? 300,
);

// ─── Signature settings ──────────────────────────────────────────

/** Current signature version. Increment when rotating to a new algorithm. */
export const CURRENT_SIGNATURE_VERSION = 1;

/** Supported signature versions for verification. */
export const SUPPORTED_SIGNATURE_VERSIONS = [1];

// ─── Encryption ──────────────────────────────────────────────────

/** Derive the AES-256-GCM encryption key for webhook secrets from an env var. */
export function getWebhookEncryptionKey(): Uint8Array {
  const hex = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!hex || hex.length < 64) {
    throw new Error(
      "WEBHOOK_SECRET_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)",
    );
  }
  return Buffer.from(hex.slice(0, 64), "hex");
}
