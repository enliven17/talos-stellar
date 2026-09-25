import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

export class TalosWebhookError extends Error {
  constructor(
    public message: string,
    public readonly code:
      | "MISSING_SIGNATURE"
      | "INVALID_HEADER"
      | "TIMESTAMP_TOO_OLD"
      | "TIMESTAMP_TOO_NEW"
      | "SIGNATURE_MISMATCH"
      | "REPLAY_DETECTED"
      | "REPLAY_MISCONFIGURED"
      | "REPLAY_STORE_ERROR"
      | "INVALID_PAYLOAD"
      | "CRYPTO_UNAVAILABLE" = "INVALID_HEADER",
  ) {
    super(message);
    this.name = "TalosWebhookError";
  }
}

export interface ReplayStore {
  /** Check if the eventId has already been processed */
  has(id: string): Promise<boolean>;
  /** Mark the eventId as processed with an expiration (TTL in seconds) */
  set(id: string, ttlSeconds: number): Promise<void>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Well-known webhook event types emitted by the Talos delivery system.
 * Unknown future types remain assignable via the open string union.
 */
export type TalosWebhookEventType =
  | "approval.approved"
  | "approval.rejected"
  | "approval.completed"
  | "revenue.recorded"
  | "dividend.distributed"
  | "activity.created"
  | "activity.completed"
  | "activity.failed"
  | (string & {});

/**
 * Typed webhook event returned after successful signature verification.
 * Secrets and raw signature material are intentionally excluded.
 */
export interface TalosWebhookEvent<T = Record<string, unknown>> {
  /** Event id when present on the payload (`id` / `eventId`). */
  id?: string;
  /** Event type string (e.g. `revenue.recorded`). */
  type: TalosWebhookEventType;
  /** Owning TALOS id when present. */
  talosId?: string;
  /** Parsed JSON body (or nested `data` / `payload` object when provided). */
  data: T;
  /** ISO timestamp from the payload when present. */
  createdAt?: string;
  /** Unix seconds from the verified signature header. */
  timestamp: number;
}

export interface VerifyWebhookOptions {
  /** The raw body of the request (must not be parsed JSON, must be exact bytes or string) */
  payload: string | Uint8Array;
  /**
   * Signature header value from `Talos-Signature` or `X-Webhook-Signature`.
   * Accepted forms: `t=<unix>,v1=<hex>` or `v1=<hex>,t=<unix>`.
   */
  signatureHeader: string;
  /** The webhook secret(s) provided by Talos. Array allows key rotation. */
  secret: string | string[];
  /** Allowed deviation in seconds between the current time and webhook timestamp. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Optional store to prevent replay attacks by recording processed event IDs. */
  replayStore?: ReplayStore;
  /** The event ID from the payload, required if replayStore is used. */
  eventId?: string;
  /** Optional logger for observability (privacy-safe: does not log payloads or secrets). */
  logger?: Logger;
  /** Optional chaos injector for fault injection during verification. */
  chaosInjector?: ChaosInjector;
}

export interface ParsedSignature {
  timestamp: number;
  /** Signature version numbers found in the header (e.g. 1 for `v1=`). */
  versions: number[];
  signatures: Array<{ version: number; hex: string }>;
}

function payloadToString(payload: string | Uint8Array): string {
  if (typeof payload === "string") return payload;
  return new TextDecoder().decode(payload);
}

/**
 * Build candidate signed-content strings for a signature version.
 * Supports both the SDK (`t.payload`) and platform delivery (`v.t.payload`) schemes.
 */
function signedContentCandidates(
  version: number,
  timestamp: number,
  payloadStr: string,
): string[] {
  return [
    `${timestamp}.${payloadStr}`,
    `${version}.${timestamp}.${payloadStr}`,
  ];
}

function parseWebhookJson(payloadStr: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadStr);
  } catch {
    throw new TalosWebhookError(
      "Webhook payload is not valid JSON",
      "INVALID_PAYLOAD",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TalosWebhookError(
      "Webhook payload must be a JSON object",
      "INVALID_PAYLOAD",
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Map a verified JSON body into a typed {@link TalosWebhookEvent}.
 * Accepts common shapes: top-level fields, or nested `data` / `payload`.
 */
export function parseWebhookEvent<T = Record<string, unknown>>(
  payload: string | Uint8Array | Record<string, unknown>,
  timestamp: number,
): TalosWebhookEvent<T> {
  const body =
    typeof payload === "string" || payload instanceof Uint8Array
      ? parseWebhookJson(payloadToString(payload))
      : payload;

  const nested =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body.payload &&
          typeof body.payload === "object" &&
          !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : undefined;

  const typeRaw =
    (typeof body.type === "string" && body.type) ||
    (typeof body.event === "string" && body.event) ||
    (typeof body.eventType === "string" && body.eventType) ||
    (nested && typeof nested.type === "string" && nested.type) ||
    "unknown";

  const id =
    (typeof body.id === "string" && body.id) ||
    (typeof body.eventId === "string" && body.eventId) ||
    undefined;

  const talosId =
    (typeof body.talosId === "string" && body.talosId) ||
    (nested && typeof nested.talosId === "string" && nested.talosId) ||
    undefined;

  const createdAt =
    (typeof body.createdAt === "string" && body.createdAt) ||
    (typeof body.timestamp === "string" && body.timestamp) ||
    undefined;

  const data = (nested ?? body) as T;

  return {
    id,
    type: typeRaw as TalosWebhookEventType,
    talosId,
    data,
    createdAt,
    timestamp,
  };
}

/**
 * Typed webhook verification helper.
 *
 * Verifies the HMAC signature (with timestamp tolerance, key rotation, and
 * optional replay protection), then returns a typed {@link TalosWebhookEvent}.
 * Never returns or logs secrets, seeds, or raw signature material.
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  options: VerifyWebhookOptions,
): Promise<TalosWebhookEvent<T>> {
  const parsed = await TalosWebhook.verify(options);
  const payloadStr = payloadToString(options.payload);
  try {
    return parseWebhookEvent<T>(payloadStr, parsed.timestamp);
  } catch (err) {
    if (err instanceof TalosWebhookError) {
      options.logger?.warn("Webhook verification failed: Invalid payload", {
        eventId: options.eventId,
        code: err.code,
      });
      throw err;
    }
    throw err;
  }
}

export class TalosWebhook {
  /**
   * Constant-time comparison to prevent timing attacks.
   */
  static timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  /**
   * Helper to decode hex string to Uint8Array.
   */
  static hexToBuf(hex: string): Uint8Array | null {
    if (hex.length % 2 !== 0) return null;
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      const byte = parseInt(hex.substring(i, i + 2), 16);
      if (Number.isNaN(byte)) return null;
      arr[i / 2] = byte;
    }
    return arr;
  }

  /**
   * Parse the signature header (e.g., "t=1620000000,v1=abc...,v1=def..."
   * or platform form "v1=abc...,t=1620000000").
   */
  static parseSignatureHeader(header: string): ParsedSignature {
    const parts = header.split(",");
    let timestamp = -1;
    const signatures: Array<{ version: number; hex: string }> = [];
    const versions = new Set<number>();

    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!value) continue;
      if (key === "t") {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          timestamp = parsed;
        }
      } else if (/^v\d+$/.test(key)) {
        const version = parseInt(key.slice(1), 10);
        if (!Number.isNaN(version)) {
          signatures.push({ version, hex: value });
          versions.add(version);
        }
      }
    }

    if (timestamp === -1) {
      throw new TalosWebhookError(
        "Missing or invalid timestamp in signature header",
        "INVALID_HEADER",
      );
    }
    if (signatures.length === 0) {
      throw new TalosWebhookError(
        "No v1 signatures found in header",
        "INVALID_HEADER",
      );
    }

    return { timestamp, versions: [...versions], signatures };
  }

  /**
   * Verify a webhook payload and signature.
   * Returns the parsed signature metadata on success (additive; callers that
   * ignore the return value remain compatible).
   */
  static async verify(options: VerifyWebhookOptions): Promise<ParsedSignature> {
    const {
      payload,
      signatureHeader,
      secret,
      toleranceSeconds = 300,
      replayStore,
      eventId,
      logger,
      chaosInjector,
    } = options;

    if (!signatureHeader) {
      logger?.warn("Webhook verification failed: Missing signature header", {
        eventId,
      });
      throw new TalosWebhookError("Missing signature header", "MISSING_SIGNATURE");
    }

    let parsed: ParsedSignature;
    try {
      parsed = this.parseSignatureHeader(signatureHeader);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid header";
      logger?.warn("Webhook verification failed: Invalid header format", {
        eventId,
        error: message,
      });
      throw err;
    }

    const { timestamp, signatures } = parsed;

    // Tolerance validation
    const now = Math.floor(Date.now() / 1000);
    if (toleranceSeconds > 0) {
      if (now - timestamp > toleranceSeconds) {
        logger?.warn(
          "Webhook verification failed: Timestamp outside tolerance (too old)",
          { eventId, timestamp, now, toleranceSeconds },
        );
        throw new TalosWebhookError(
          "Timestamp outside tolerance zone (too old)",
          "TIMESTAMP_TOO_OLD",
        );
      }
      if (timestamp - now > toleranceSeconds) {
        logger?.warn(
          "Webhook verification failed: Timestamp outside tolerance (too far in future)",
          { eventId, timestamp, now, toleranceSeconds },
        );
        throw new TalosWebhookError(
          "Timestamp outside tolerance zone (too far in future)",
          "TIMESTAMP_TOO_NEW",
        );
      }
    }

    const payloadStr = payloadToString(payload);
    const secrets = Array.isArray(secret) ? secret : [secret];
    const textEncoder = new TextEncoder();

    let isValid = false;

    const cryptoSubtle = globalThis.crypto?.subtle;
    if (!cryptoSubtle) {
      logger?.error("Web Crypto API is not available in this environment", {
        eventId,
      });
      throw new TalosWebhookError(
        "Web Crypto API is not available. Please use an environment that supports it.",
        "CRYPTO_UNAVAILABLE",
      );
    }

    if (chaosInjector) {
      await chaosInjector.maybeInjectFault(
        FaultType.SIGNATURE_VERIFICATION_SLOW,
      );
    }

    for (const sig of signatures) {
      const sigBuf = this.hexToBuf(sig.hex);
      if (!sigBuf) continue;

      const candidates = signedContentCandidates(
        sig.version,
        timestamp,
        payloadStr,
      );

      for (const signedContent of candidates) {
        const encodedContent = textEncoder.encode(signedContent);
        for (const s of secrets) {
          if (!s) continue;
          try {
            const key = await cryptoSubtle.importKey(
              "raw",
              textEncoder.encode(s),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            );
            const expectedSigBuf = new Uint8Array(
              await cryptoSubtle.sign("HMAC", key, encodedContent),
            );

            if (this.timingSafeEqual(sigBuf, expectedSigBuf)) {
              isValid = true;
              break;
            }
          } catch {
            // Ignore cryptographic errors during loop and continue
          }
        }
        if (isValid) break;
      }
      if (isValid) break;
    }

    if (!isValid) {
      logger?.warn("Webhook verification failed: Signature mismatch", {
        eventId,
        timestamp,
      });
      throw new TalosWebhookError(
        "No valid signatures found",
        "SIGNATURE_MISMATCH",
      );
    }

    // Replay protection
    if (replayStore) {
      if (!eventId) {
        logger?.error(
          "Webhook verification misconfigured: replayStore provided but eventId missing",
          {},
        );
        throw new TalosWebhookError(
          "eventId is required when using replayStore",
          "REPLAY_MISCONFIGURED",
        );
      }

      try {
        if (chaosInjector) {
          await chaosInjector.maybeInjectFault(FaultType.REPLAY_STORE_ERROR);
        }
        const isReplay = await replayStore.has(eventId);
        if (isReplay) {
          logger?.warn("Webhook verification failed: Replay detected", {
            eventId,
          });
          throw new TalosWebhookError(
            "Event has already been processed (replay detected)",
            "REPLAY_DETECTED",
          );
        }

        const ttl = toleranceSeconds > 0 ? toleranceSeconds + 60 : 86400;
        if (chaosInjector) {
          await chaosInjector.maybeInjectFault(FaultType.REPLAY_STORE_ERROR);
        }
        await replayStore.set(eventId, ttl);
      } catch (err: unknown) {
        if (err instanceof TalosWebhookError) throw err;
        const message = err instanceof Error ? err.message : "unknown error";
        logger?.error("Webhook verification: replayStore error", {
          eventId,
          error: message,
        });
        throw new TalosWebhookError(
          `Replay store error: ${message}`,
          "REPLAY_STORE_ERROR",
        );
      }
    }

    logger?.info("Webhook verification successful", { eventId, timestamp });
    return parsed;
  }

  /**
   * Verify signature and return a typed webhook event.
   * @see verifyWebhook
   */
  static async constructEvent<T = Record<string, unknown>>(
    options: VerifyWebhookOptions,
  ): Promise<TalosWebhookEvent<T>> {
    return verifyWebhook<T>(options);
  }
}
