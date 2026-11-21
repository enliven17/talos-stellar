/**
 * Webhook payload signing utilities.
 *
 * Outgoing webhook payloads are signed using HMAC-SHA256 with a versioned
 * signature scheme. The signature is sent as an HTTP header:
 *
 *   X-Webhook-Signature: v1=<hmac>,t=<unix_timestamp>
 *
 * During secret rotation the header may carry multiple HMACs so consumers
 * still verifying with the previous secret succeed without downtime:
 *
 *   X-Webhook-Signature: v1=<hmac_current>,v1=<hmac_previous>,t=<unix_timestamp>
 *
 * The timestamp enables replay protection: consumers should reject signatures
 * older than a configured tolerance (e.g. 5 minutes).
 *
 * Secret management:
 *   - Secrets are encrypted at rest (AES-256-GCM) in the database.
 *   - They are decrypted only at delivery time for signing purposes.
 *   - Secrets are never logged or exposed via the API (except the one-time
 *     plaintext returned when generate=true on rotate).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { CURRENT_SIGNATURE_VERSION, SUPPORTED_SIGNATURE_VERSIONS } from "./config";

/** Maximum tolerable age for an incoming signature (seconds). */
const MAX_TIMESTAMP_AGE_SEC = 300; // 5 minutes

/** Prefix for deterministic, non-reversible webhook signing key identifiers. */
export const WEBHOOK_KEY_ID_PREFIX = "whkid_";

const KEY_ID_DOMAIN = "talos-webhook-kid:v1:";

export interface SigningKey {
  /** Non-reversible key identifier (e.g. `whkid_<16-hex>`). */
  id: string;
  /** Plaintext HMAC signing secret. */
  secret: string;
}

export interface SignedPayloadBundle {
  /** Value for `X-Webhook-Signature`: `v1=<hmac>[,v1=<hmac>...],t=<ts>`. */
  signature: string;
  /** Ordered key IDs matching each `v<version>=<hmac>` entry in `signature`. */
  keyIds: string[];
  /** Value for `X-Webhook-Key-Id`: comma-separated key IDs. */
  keyIdHeader: string;
  /** UNIX timestamp (seconds) embedded in the signature. */
  timestamp: number;
  /** Signature scheme version. */
  version: number;
}

export type VerificationFailureReason =
  | "missing_signature"
  | "missing_secrets"
  | "malformed_header"
  | "expired_timestamp"
  | "unsupported_version"
  | "key_id_mismatch"
  | "invalid_signature";

export interface SignatureVerificationResult {
  valid: boolean;
  matchedKeyId?: string;
  version?: number;
  timestamp?: number;
  reason?: VerificationFailureReason;
}

export interface VerifySignatureOptions {
  /** Optional `X-Webhook-Key-Id` header value for key-ID-aware verification. */
  keyIdHeader?: string | null;
  /** Override current UNIX timestamp in seconds (for deterministic tests). */
  nowSec?: number;
  /** Maximum tolerable timestamp age in seconds (defaults to 300). */
  maxAgeSec?: number;
}

/**
 * Derive a deterministic, privacy-safe key identifier from a webhook secret.
 *
 * Uses a domain-separated SHA-256 prefix so key IDs can be safely exposed in
 * HTTP headers, API responses, and logs without revealing secret material.
 */
export function deriveSigningKeyId(secret: string): string {
  const digest = createHash("sha256")
    .update(KEY_ID_DOMAIN)
    .update(secret)
    .digest("hex")
    .slice(0, 16);
  return `${WEBHOOK_KEY_ID_PREFIX}${digest}`;
}

function asSecretList(secret: string | string[]): string[] {
  const list = Array.isArray(secret) ? secret : [secret];
  return list.filter((s) => typeof s === "string" && s.length > 0);
}

function normalizeVerificationKeys(
  keys: string | string[] | SigningKey[] | Record<string, string>,
): { list: SigningKey[]; byId: Map<string, string>; explicitKeyIds: boolean } {
  const list: SigningKey[] = [];
  const byId = new Map<string, string>();
  let explicitKeyIds = false;

  if (typeof keys === "string") {
    if (keys.length > 0) {
      const id = deriveSigningKeyId(keys);
      list.push({ id, secret: keys });
      byId.set(id, keys);
    }
  } else if (Array.isArray(keys)) {
    for (const item of keys) {
      if (typeof item === "string") {
        if (item.length > 0) {
          const id = deriveSigningKeyId(item);
          list.push({ id, secret: item });
          byId.set(id, item);
        }
      } else if (item && typeof item.secret === "string" && item.secret.length > 0) {
        const id = item.id || deriveSigningKeyId(item.secret);
        explicitKeyIds = true;
        list.push({ id, secret: item.secret });
        byId.set(id, item.secret);
      }
    }
  } else if (keys && typeof keys === "object") {
    explicitKeyIds = true;
    for (const [id, secret] of Object.entries(keys)) {
      if (typeof secret === "string" && secret.length > 0 && id.length > 0) {
        list.push({ id, secret });
        byId.set(id, secret);
      }
    }
  }

  return { list, byId, explicitKeyIds };
}

/**
 * Build the signature and key-ID header values for a webhook payload.
 *
 * Pass multiple keys (current + previous) to dual-sign during a controlled
 * rotation overlap window. `keyIds` are emitted in the same positional order
 * as the `v<version>=<hmac>` entries in `signature`.
 */
export function signPayloadWithKeyIds(
  payload: string,
  keys: SigningKey[],
  version: number = CURRENT_SIGNATURE_VERSION,
  nowSec?: number,
): SignedPayloadBundle {
  const validKeys = keys.filter(
    (k) => k && typeof k.secret === "string" && k.secret.length > 0,
  );
  if (validKeys.length === 0) {
    throw new Error("At least one signing secret is required");
  }

  const timestamp = nowSec ?? Math.floor(Date.now() / 1000);
  const dataToSign = `${version}.${timestamp}.${payload}`;
  const parts: string[] = [];
  const keyIds: string[] = [];

  for (const key of validKeys) {
    const hmac = createHmac("sha256", key.secret).update(dataToSign).digest("hex");
    parts.push(`v${version}=${hmac}`);
    keyIds.push(key.id || deriveSigningKeyId(key.secret));
  }

  return {
    signature: `${parts.join(",")},t=${timestamp}`,
    keyIds,
    keyIdHeader: keyIds.join(","),
    timestamp,
    version,
  };
}

/**
 * Build the signature header value for a webhook payload.
 *
 * Pass multiple secrets (current + previous) to dual-sign during rotation.
 * Format: `v1=<hmac>[,v1=<hmac>...],t=<unix_timestamp>`
 */
export function signPayload(
  payload: string,
  secret: string | string[],
  version: number = CURRENT_SIGNATURE_VERSION,
): string {
  const secrets = asSecretList(secret);
  if (secrets.length === 0) {
    throw new Error("At least one signing secret is required");
  }

  return signPayloadWithKeyIds(
    payload,
    secrets.map((s) => ({ id: deriveSigningKeyId(s), secret: s })),
    version,
  ).signature;
}

/**
 * Verify a webhook signature header and return structured verification details.
 *
 * Supports:
 *   - Single secret (`string`)
 *   - Multiple secrets (`string[]`)
 *   - Key-ID-indexed secrets (`SigningKey[]` or `Record<string, string>`)
 *   - Optional `X-Webhook-Key-Id` header for targeted key selection during
 *     controlled rotation overlap.
 */
export function verifySignatureWithDetails(
  payload: string,
  signatureHeader: string | null,
  keys: string | string[] | SigningKey[] | Record<string, string>,
  options: VerifySignatureOptions = {},
): SignatureVerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  const { list, byId } = normalizeVerificationKeys(keys);
  if (list.length === 0) {
    return { valid: false, reason: "missing_secrets" };
  }

  try {
    const parts = signatureHeader.split(",").map((p) => p.trim());
    const tPart = parts.find((p) => p.startsWith("t="));
    if (!tPart) {
      return { valid: false, reason: "malformed_header" };
    }

    const timestamp = Number(tPart.slice(2));
    if (!Number.isFinite(timestamp)) {
      return { valid: false, reason: "malformed_header" };
    }

    const now = options.nowSec ?? Math.floor(Date.now() / 1000);
    const maxAge = options.maxAgeSec ?? MAX_TIMESTAMP_AGE_SEC;
    if (Math.abs(now - timestamp) > maxAge) {
      return { valid: false, timestamp, reason: "expired_timestamp" };
    }

    const sigParts = parts.filter((p) => /^v\d+=/.test(p));
    if (sigParts.length === 0) {
      return { valid: false, timestamp, reason: "malformed_header" };
    }

    const advertisedKeyIds = options.keyIdHeader
      ? options.keyIdHeader
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      : [];

    let sawSupportedVersion = false;
    let sawMatchingKeyId = false;

    for (let i = 0; i < sigParts.length; i++) {
      const versionMatch = sigParts[i].match(/^v(\d+)=(.+)$/);
      if (!versionMatch) continue;

      const version = Number(versionMatch[1]);
      const providedHmac = versionMatch[2];

      if (!SUPPORTED_SIGNATURE_VERSIONS.includes(version)) continue;
      sawSupportedVersion = true;

      const dataToSign = `${version}.${timestamp}.${payload}`;
      const provided = Buffer.from(providedHmac, "hex");
      if (provided.length === 0) continue;

      // If X-Webhook-Key-Id is provided, narrow candidates to the matching key ID
      // (positional match when aligned, otherwise any advertised key ID present).
      let candidates: SigningKey[];
      if (advertisedKeyIds.length > 0) {
        const positionalId = advertisedKeyIds[i];
        if (positionalId && byId.has(positionalId)) {
          candidates = [{ id: positionalId, secret: byId.get(positionalId)! }];
          sawMatchingKeyId = true;
        } else {
          const matched = advertisedKeyIds
            .filter((id) => byId.has(id))
            .map((id) => ({ id, secret: byId.get(id)! }));
          if (matched.length > 0) {
            sawMatchingKeyId = true;
          }
          candidates = matched;
        }
      } else {
        candidates = list;
      }

      for (const candidate of candidates) {
        const expectedHmac = createHmac("sha256", candidate.secret)
          .update(dataToSign)
          .digest("hex");
        const expected = Buffer.from(expectedHmac, "hex");
        if (provided.length !== expected.length) continue;
        if (timingSafeEqual(provided, expected)) {
          return {
            valid: true,
            matchedKeyId: candidate.id,
            version,
            timestamp,
          };
        }
      }
    }

    if (!sawSupportedVersion) {
      return { valid: false, timestamp, reason: "unsupported_version" };
    }
    if (advertisedKeyIds.length > 0 && !sawMatchingKeyId) {
      return { valid: false, timestamp, reason: "key_id_mismatch" };
    }

    return { valid: false, timestamp, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "malformed_header" };
  }
}

/**
 * Verify a webhook signature header against a payload.
 *
 * Accepts a single secret or an array (consumer-side key rotation).
 * Returns `true` if any provided HMAC matches any secret, the version is
 * supported, and the timestamp is within the acceptable age window.
 */
export function verifySignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | string[],
): boolean {
  return verifySignatureWithDetails(payload, signatureHeader, secret).valid;
}

// ─── Encryption at rest for webhook secrets ──────────────────────

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getWebhookEncryptionKey } from "./config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Encrypt a webhook secret for at-rest storage.
 *
 * Returns a hex-encoded string containing: iv + authTag + ciphertext.
 */
export function encryptSecret(plaintext: string): string {
  const key = getWebhookEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  // Format: iv (32 hex chars) + authTag (32 hex chars) + ciphertext
  return `${iv.toString("hex")}${authTag}${encrypted}`;
}

/**
 * Decrypt a webhook secret that was encrypted with encryptSecret().
 */
export function decryptSecret(ciphertext: string): string {
  const key = getWebhookEncryptionKey();
  const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), "hex");
  const authTag = Buffer.from(
    ciphertext.slice(IV_LENGTH * 2, IV_LENGTH * 2 + TAG_LENGTH * 2),
    "hex",
  );
  const encrypted = ciphertext.slice(IV_LENGTH * 2 + TAG_LENGTH * 2);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Mask a webhook secret for safe logging (show last 4 chars).
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
