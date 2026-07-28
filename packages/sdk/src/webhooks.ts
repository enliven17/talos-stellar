import type { ChaosInjector } from "./chaos.js";
import { FaultType } from "./chaos.js";

export class TalosWebhookError extends Error {
  constructor(public message: string) {
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

export interface VerifyWebhookOptions {
  /** The raw body of the request (must not be parsed JSON, must be exact bytes or string) */
  payload: string | Uint8Array;
  /** The Talos-Signature header value */
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
  signatures: string[];
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
   * Parse the signature header (e.g., "t=1620000000,v1=abc...,v1=def...")
   */
  static parseSignatureHeader(header: string): ParsedSignature {
    const parts = header.split(",");
    let timestamp = -1;
    const signatures: string[] = [];

    for (const part of parts) {
      const [key, value] = part.split("=");
      if (!key || !value) continue;
      if (key === "t") {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          timestamp = parsed;
        }
      } else if (key === "v1") {
        signatures.push(value);
      }
    }

    if (timestamp === -1) {
      throw new TalosWebhookError(
        "Missing or invalid timestamp in signature header",
      );
    }
    if (signatures.length === 0) {
      throw new TalosWebhookError("No v1 signatures found in header");
    }

    return { timestamp, signatures };
  }

  /**
   * Verify a webhook payload and signature.
   */
  static async verify(options: VerifyWebhookOptions): Promise<void> {
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
      throw new TalosWebhookError("Missing signature header");
    }

    let parsed: ParsedSignature;
    try {
      parsed = this.parseSignatureHeader(signatureHeader);
    } catch (err: any) {
      logger?.warn("Webhook verification failed: Invalid header format", {
        eventId,
        error: err.message,
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
        );
      }
      if (timestamp - now > toleranceSeconds) {
        logger?.warn(
          "Webhook verification failed: Timestamp outside tolerance (too far in future)",
          { eventId, timestamp, now, toleranceSeconds },
        );
        throw new TalosWebhookError(
          "Timestamp outside tolerance zone (too far in future)",
        );
      }
    }

    // Payload preparation
    let payloadStr: string;
    if (typeof payload === "string") {
      payloadStr = payload;
    } else {
      payloadStr = new TextDecoder().decode(payload);
    }

    const signedContent = `${timestamp}.${payloadStr}`;
    const secrets = Array.isArray(secret) ? secret : [secret];
    const textEncoder = new TextEncoder();
    const encodedContent = textEncoder.encode(signedContent);

    let isValid = false;

    // We use Web Crypto API (globalThis.crypto.subtle) which is supported in Node 18+, Edge, and Browsers.
    const cryptoSubtle = globalThis.crypto?.subtle;
    if (!cryptoSubtle) {
      logger?.error("Web Crypto API is not available in this environment", {
        eventId,
      });
      throw new Error(
        "Web Crypto API is not available. Please use an environment that supports it.",
      );
    }

    if (chaosInjector) {
      await chaosInjector.maybeInjectFault(
        FaultType.SIGNATURE_VERIFICATION_SLOW,
      );
    }

    for (const sig of signatures) {
      const sigBuf = this.hexToBuf(sig);
      if (!sigBuf) continue;

      for (const s of secrets) {
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
        } catch (err) {
          // Ignore cryptographic errors during loop and continue
        }
      }
      if (isValid) break;
    }

    if (!isValid) {
      logger?.warn("Webhook verification failed: Signature mismatch", {
        eventId,
        timestamp,
      });
      throw new TalosWebhookError("No valid signatures found");
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
          );
        }

        // Store with TTL (tolerance + buffer) or default to 24 hours if no tolerance
        const ttl = toleranceSeconds > 0 ? toleranceSeconds + 60 : 86400;
        if (chaosInjector) {
          await chaosInjector.maybeInjectFault(FaultType.REPLAY_STORE_ERROR);
        }
        await replayStore.set(eventId, ttl);
      } catch (err: any) {
        logger?.error("Webhook verification: replayStore error", {
          eventId,
          error: err.message,
        });
        throw new TalosWebhookError(`Replay store error: ${err.message}`);
      }
    }

    logger?.info("Webhook verification successful", { eventId, timestamp });
  }
}
