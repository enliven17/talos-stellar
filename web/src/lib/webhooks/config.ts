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

// ─── Numeric environment parser ──────────────────────────────────

export interface PositiveIntEnvOptions {
  /** Minimum allowable value (inclusive). Defaults to 1. */
  min?: number;
  /** Maximum allowable value (inclusive). Defaults to Number.MAX_SAFE_INTEGER. */
  max?: number;
  /**
   * Action taken when an invalid or out-of-range value is encountered.
   * - "throw" (default): Fail fast at startup by throwing an Error.
   * - "fallback": Log a warning and fall back to defaultValue.
   */
  onError?: "throw" | "fallback";
}

/**
 * Validates and parses a positive integer from process.env[name].
 *
 * Validation strategy:
 * Fails fast at startup (onError: "throw") by default when an environment variable
 * contains an invalid string (e.g. "1s", "1.5", "abc"), special floats ("NaN", "Infinity"),
 * negative values, zeroes, or values outside the specified [min, max] range.
 *
 * When the environment variable is unset or empty string, defaultValue is returned directly.
 */
export function parsePositiveIntEnv(
  name: string,
  defaultValue: number,
  options?: PositiveIntEnvOptions,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  const trimmed = raw.trim();
  const min = options?.min ?? 1;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  const onError = options?.onError ?? "throw";

  const isDigits = /^\+?\d+$/.test(trimmed);
  const parsed = isDigits ? Number(trimmed) : NaN;
  const isValid =
    isDigits &&
    Number.isSafeInteger(parsed) &&
    parsed >= min &&
    parsed <= max;

  if (!isValid) {
    const boundsDesc =
      max === Number.MAX_SAFE_INTEGER
        ? `>= ${min}`
        : `between ${min} and ${max}`;
    const message = `[webhooks] Invalid value for ${name}: "${raw}" — must be a positive integer (${boundsDesc})`;

    if (onError === "fallback") {
      console.warn(`${message}; falling back to default ${defaultValue}`);
      return defaultValue;
    }

    throw new Error(message);
  }

  return parsed;
}

// ─── Delivery settings ───────────────────────────────────────────

/** Default maximum delivery attempts before moving to dead-letter. */
export const DEFAULT_MAX_ATTEMPTS = parsePositiveIntEnv(
  "WEBHOOK_DEFAULT_MAX_ATTEMPTS",
  5,
  { min: 1, max: 100 },
);

/** Base delay (ms) for exponential backoff: delay = base * 2^attempt */
export const BACKOFF_BASE_MS = parsePositiveIntEnv(
  "WEBHOOK_BACKOFF_BASE_MS",
  1_000,
  { min: 1, max: 300_000 },
);

/** Maximum backoff delay cap (ms). */
export const BACKOFF_MAX_MS = parsePositiveIntEnv(
  "WEBHOOK_BACKOFF_MAX_MS",
  60_000,
  { min: 1, max: 86_400_000 },
);

/** HTTP request timeout (ms) for outbound webhook delivery. */
export const DELIVERY_TIMEOUT_MS = parsePositiveIntEnv(
  "WEBHOOK_DELIVERY_TIMEOUT_MS",
  10_000,
  { min: 1, max: 300_000 },
);

/** Maximum payload body size (bytes) to accept when creating deliveries. */
export const MAX_PAYLOAD_BYTES = parsePositiveIntEnv(
  "WEBHOOK_MAX_PAYLOAD_BYTES",
  64_000,
  { min: 1, max: 10_485_760 },
);

// ─── Lease settings (same pattern as commerce jobs) ──────────────

/** Default lease TTL (seconds) for a claimed delivery. */
export const DEFAULT_LEASE_TTL_SECONDS = parsePositiveIntEnv(
  "WEBHOOK_LEASE_TTL_SECONDS",
  300,
  { min: 1, max: 86_400 },
);

/** Heartbeat extends lease by this many seconds. */
export const HEARTBEAT_EXTEND_SECONDS = parsePositiveIntEnv(
  "WEBHOOK_HEARTBEAT_EXTEND_SECONDS",
  300,
  { min: 1, max: 86_400 },
);

// ─── Signature settings ──────────────────────────────────────────

/** Current signature version. Increment when rotating to a new algorithm. */
export const CURRENT_SIGNATURE_VERSION = 1;

/** Supported signature versions for verification. */
export const SUPPORTED_SIGNATURE_VERSIONS = [1];

// ─── Secret rotation ─────────────────────────────────────────────

/** Minimum allowed grace window (5 minutes). */
export const MIN_SECRET_ROTATION_GRACE_SECONDS = 300;

/** Maximum allowed grace window (30 days). */
export const MAX_SECRET_ROTATION_GRACE_SECONDS = 2_592_000;

/** Default overlap window (seconds) while previous + current secrets dual-sign. */
export const DEFAULT_SECRET_ROTATION_GRACE_SECONDS = parsePositiveIntEnv(
  "WEBHOOK_SECRET_ROTATION_GRACE_SECONDS",
  86_400,
  {
    min: MIN_SECRET_ROTATION_GRACE_SECONDS,
    max: MAX_SECRET_ROTATION_GRACE_SECONDS,
  },
);

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
