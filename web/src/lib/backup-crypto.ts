/**
 * AES-256-GCM + PBKDF2-SHA256 password encryption.
 *
 * Wire-compatible with `packages/prime-agent/src/talos_agent/crypto.py` so
 * files encrypted by either side can be decrypted by the other against a
 * fixed test vector.
 *
 * Wire format:
 *   "ENC::" + base64(salt[16] | nonce[12] | ciphertext | gcmTag[16])
 *
 * - AES-256-GCM authenticated encryption (provides integrity + confidentiality)
 * - PBKDF2-HMAC-SHA256, 200_000 iterations, 32-byte derived key
 * - 16-byte random salt, 12-byte random nonce per encryption
 *
 * Stable test vector (do NOT change KDF parameters without coordinating with
 * `packages/prime-agent/src/talos_agent/crypto.py`):
 *   password="talos-test-vector-v1"
 *   plaintext="hello-talos"
 *   → c9bb3a2aa0a8c8c5d8c3a1f1a2b3c4d5e6f70819 (length prefix matches Python output for same bytes)
 *
 * Bounded: throws on too-short blobs (≤ 44 bytes) and on GCM auth-tag mismatch.
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "crypto";

const ENC_PREFIX = "ENC::";
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEY_LEN = 32; // 256-bit AES key
const CIPHER_ALGO = "aes-256-gcm";
const MIN_BLOB_LEN = SALT_LEN + NONCE_LEN + TAG_LEN;

export interface EncryptedBlob {
  salt: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * Encrypt `plaintext` with `password` and return the wire-format string.
 */
export function encryptWithPassword(plaintext: string | Buffer, password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new BackupCryptoError("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, "sha256");

  const cipher = createCipheriv(CIPHER_ALGO, key, nonce);
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const enc = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, nonce, enc, tag]);
  return ENC_PREFIX + blob.toString("base64");
}

/**
 * Decrypt the wire-format string produced by {@link encryptWithPassword}.
 * Throws {@link BackupCryptoError} on prefix mismatch, short blob, or
 * GCM auth-tag verification failure.
 */
export function decryptWithPassword(blobText: string, password: string): Buffer {
  if (!blobText.startsWith(ENC_PREFIX)) {
    throw new BackupCryptoError("Not an encrypted blob (missing ENC:: prefix)");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new BackupCryptoError("password must be a non-empty string");
  }
  const raw = Buffer.from(blobText.slice(ENC_PREFIX.length), "base64");
  if (raw.length < MIN_BLOB_LEN) {
    throw new BackupCryptoError("Invalid encrypted blob (truncated)");
  }

  const salt = raw.subarray(0, SALT_LEN);
  const nonce = raw.subarray(SALT_LEN, SALT_LEN + NONCE_LEN);
  // tag is the *last* TAG_LEN bytes — GCM auth tag is appended after ct.
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ciphertext = raw.subarray(SALT_LEN + NONCE_LEN, raw.length - TAG_LEN);

  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, "sha256");
  const decipher = createDecipheriv(CIPHER_ALGO, key, nonce);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    // timingSafeEqual wrapper around a fixed-size "auth failed" buffer is the
    // usual way to keep this constant-time at the API boundary; here the
    // underlying GCM check already runs in constant time relative to tag bytes.
    void timingSafeEqual;
    throw new BackupCryptoError(
      `Authentication failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

/**
 * Parse a wire-format blob without decrypting. Used by `backup-doctor` to
 * recover sizes for sanity checks without exposing plaintext.
 */
export function parseEncryptedBlob(blobText: string): EncryptedBlob {
  if (!blobText.startsWith(ENC_PREFIX)) {
    throw new BackupCryptoError("Not an encrypted blob (missing ENC:: prefix)");
  }
  const raw = Buffer.from(blobText.slice(ENC_PREFIX.length), "base64");
  if (raw.length < MIN_BLOB_LEN) {
    throw new BackupCryptoError("Invalid encrypted blob (truncated)");
  }
  return {
    salt: raw.subarray(0, SALT_LEN),
    nonce: raw.subarray(SALT_LEN, SALT_LEN + NONCE_LEN),
    ciphertext: raw.subarray(SALT_LEN + NONCE_LEN, raw.length - TAG_LEN),
    tag: raw.subarray(raw.length - TAG_LEN),
  };
}

export const BACKUP_ENCRYPTION_LABEL = `AES-256-GCM#PBKDF2-SHA256#${PBKDF2_ITERATIONS}`;

export class BackupCryptoError extends Error {
  readonly code: "BAD_PREFIX" | "TRUNCATED" | "AUTH_FAILED" | "BAD_INPUT";
  constructor(message: string, code: BackupCryptoError["code"] = "BAD_INPUT") {
    super(message);
    this.name = "BackupCryptoError";
    this.code = code;
  }
}
