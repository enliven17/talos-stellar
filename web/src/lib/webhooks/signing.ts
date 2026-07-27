/**
 * Webhook payload signing utilities.
 *
 * Outgoing webhook payloads are signed using HMAC-SHA256 with a versioned
 * signature scheme. The signature is sent as an HTTP header:
 *
 *   X-Webhook-Signature: v1=<hmac>,t=<unix_timestamp>
 *
 * The timestamp enables replay protection: consumers should reject signatures
 * older than a configured tolerance (e.g. 5 minutes).
 *
 * Secret management:
 *   - Secrets are encrypted at rest (AES-256-GCM) in the database.
 *   - They are decrypted only at delivery time for signing purposes.
 *   - Secrets are never logged or exposed via the API.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { CURRENT_SIGNATURE_VERSION, SUPPORTED_SIGNATURE_VERSIONS } from "./config";

/** Maximum tolerable age for an incoming signature (seconds). */
const MAX_TIMESTAMP_AGE_SEC = 300; // 5 minutes

/**
 * Build the signature header value for a webhook payload.
 *
 * Format: `v1=<hmac>,t=<unix_timestamp>`
 */
export function signPayload(
  payload: string,
  secret: string,
  version: number = CURRENT_SIGNATURE_VERSION,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const dataToSign = `${version}.${timestamp}.${payload}`;
  const hmac = createHmac("sha256", secret).update(dataToSign).digest("hex");
  return `v${version}=${hmac},t=${timestamp}`;
}

/**
 * Verify a webhook signature header against a payload.
 *
 * Returns `true` if the signature is valid, the version is supported,
 * and the timestamp is within the acceptable age window.
 */
export function verifySignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  try {
    // Parse the header: "v1=<hmac>,t=<timestamp>"
    const parts = signatureHeader.split(",");
    const sigPart = parts.find((p) => p.startsWith("v"));
    const tPart = parts.find((p) => p.startsWith("t="));

    if (!sigPart || !tPart) return false;

    const versionMatch = sigPart.match(/^v(\d+)=(.+)$/);
    if (!versionMatch) return false;

    const version = Number(versionMatch[1]);
    const providedHmac = versionMatch[2];
    const timestamp = Number(tPart.slice(2));

    // Reject unsupported versions
    if (!SUPPORTED_SIGNATURE_VERSIONS.includes(version)) return false;

    // Reject expired timestamps (replay protection)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > MAX_TIMESTAMP_AGE_SEC) return false;

    // Recompute the HMAC
    const dataToSign = `${version}.${timestamp}.${payload}`;
    const expectedHmac = createHmac("sha256", secret)
      .update(dataToSign)
      .digest("hex");

    // Timing-safe comparison
    const provided = Buffer.from(providedHmac, "hex");
    const expected = Buffer.from(expectedHmac, "hex");

    if (provided.length === 0 || provided.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
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
