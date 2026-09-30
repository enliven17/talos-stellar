/**
 * Zero-downtime webhook signing-secret rotation.
 *
 * Rotation keeps the previous encrypted secret for a grace window so
 * outbound deliveries can dual-sign with both current and previous keys.
 * Consumers verifying with either secret continue to succeed until the
 * grace window expires (or an operator finalizes early).
 *
 * Secrets are never logged or returned after the one-time rotate response
 * that optionally echoes a server-generated plaintext.
 */

import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { tlsWebhookSubscriptions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import {
  DEFAULT_SECRET_ROTATION_GRACE_SECONDS,
  MAX_SECRET_ROTATION_GRACE_SECONDS,
  MIN_SECRET_ROTATION_GRACE_SECONDS,
} from "./config";
import { decryptSecret, encryptSecret } from "./signing";

export interface RotationResult {
  id: string;
  secretRotatedAt: Date;
  previousSecretExpiresAt: Date;
  graceSeconds: number;
  /** Present only when the server generated the secret — shown once. */
  secret?: string;
  rotationActive: true;
}

export interface FinalizeResult {
  id: string;
  previousSecretCleared: boolean;
  rotationActive: false;
}

export interface SigningSecretBundle {
  /** Secrets to dual-sign with (current first, then previous if in grace). */
  secrets: string[];
  signatureVersion: number;
  rotationActive: boolean;
}

function clampGraceSeconds(raw: number | undefined): number {
  const fallback = DEFAULT_SECRET_ROTATION_GRACE_SECONDS;
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < MIN_SECRET_ROTATION_GRACE_SECONDS) return MIN_SECRET_ROTATION_GRACE_SECONDS;
  if (n > MAX_SECRET_ROTATION_GRACE_SECONDS) return MAX_SECRET_ROTATION_GRACE_SECONDS;
  return n;
}

/** Generate a webhook signing secret (`whsec_` + 32 random bytes hex). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/**
 * Resolve the plaintext secrets that should sign an outbound delivery.
 * Expired previous secrets are omitted (lazy expiry — no write required).
 */
export function resolveSigningSecrets(subscription: {
  secretCiphertext: string;
  previousSecretCiphertext?: string | null;
  previousSecretExpiresAt?: Date | null;
  signatureVersion: number;
}): SigningSecretBundle {
  const secrets: string[] = [decryptSecret(subscription.secretCiphertext)];
  let rotationActive = false;

  const prevCipher = subscription.previousSecretCiphertext;
  const expiresAt = subscription.previousSecretExpiresAt;
  if (prevCipher && expiresAt && expiresAt.getTime() > Date.now()) {
    try {
      secrets.push(decryptSecret(prevCipher));
      rotationActive = true;
    } catch (err) {
      // Previous secret unreadable — continue with current only.
      logger.warn(
        { err: err instanceof Error ? err.message : "decrypt_failed" },
        "webhook_previous_secret_decrypt_failed",
      );
    }
  }

  return {
    secrets,
    signatureVersion: subscription.signatureVersion,
    rotationActive,
  };
}

/**
 * Rotate the signing secret for a subscription.
 *
 * Moves the current ciphertext into the previous slot (with grace expiry)
 * and installs the new secret as current. Delivery dual-signs until expiry.
 */
export async function rotateWebhookSecret(opts: {
  subscriptionId: string;
  talosId: string;
  newSecret?: string;
  generate?: boolean;
  graceSeconds?: number;
}): Promise<RotationResult | { error: string; status: number }> {
  const { subscriptionId, talosId, generate } = opts;

  let plaintext = opts.newSecret;
  if (generate || !plaintext) {
    if (!generate && !plaintext) {
      return { error: "Provide secret or set generate=true", status: 400 };
    }
    plaintext = generateWebhookSecret();
  }

  if (plaintext.length < 16 || plaintext.length > 256) {
    return { error: "Secret must be 16–256 characters", status: 400 };
  }

  const graceSeconds = clampGraceSeconds(opts.graceSeconds);
  const now = new Date();
  const previousSecretExpiresAt = new Date(now.getTime() + graceSeconds * 1000);

  let newCiphertext: string;
  try {
    newCiphertext = encryptSecret(plaintext);
  } catch (err) {
    logger.error({ err }, "webhook_secret_encrypt_failed");
    return {
      error: "Failed to encrypt webhook secret. Check WEBHOOK_SECRET_ENCRYPTION_KEY.",
      status: 500,
    };
  }

  const existing = await db
    .select({
      id: tlsWebhookSubscriptions.id,
      secretCiphertext: tlsWebhookSubscriptions.secretCiphertext,
    })
    .from(tlsWebhookSubscriptions)
    .where(
      and(
        eq(tlsWebhookSubscriptions.id, subscriptionId),
        eq(tlsWebhookSubscriptions.talosId, talosId),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!existing) {
    return { error: "Subscription not found", status: 404 };
  }

  const [updated] = await db
    .update(tlsWebhookSubscriptions)
    .set({
      previousSecretCiphertext: existing.secretCiphertext,
      previousSecretExpiresAt,
      secretCiphertext: newCiphertext,
      secretRotatedAt: now,
      // Keep signature scheme version stable; dual-sign covers overlap.
      signatureVersion: 1,
    })
    .where(
      and(
        eq(tlsWebhookSubscriptions.id, subscriptionId),
        eq(tlsWebhookSubscriptions.talosId, talosId),
      ),
    )
    .returning({
      id: tlsWebhookSubscriptions.id,
      secretRotatedAt: tlsWebhookSubscriptions.secretRotatedAt,
      previousSecretExpiresAt: tlsWebhookSubscriptions.previousSecretExpiresAt,
    });

  if (!updated || !updated.secretRotatedAt || !updated.previousSecretExpiresAt) {
    return { error: "Subscription not found", status: 404 };
  }

  logger.info(
    {
      subscriptionId,
      talosId,
      graceSeconds,
      previousSecretExpiresAt: updated.previousSecretExpiresAt.toISOString(),
    },
    "webhook_secret_rotated",
  );

  const result: RotationResult = {
    id: updated.id,
    secretRotatedAt: updated.secretRotatedAt,
    previousSecretExpiresAt: updated.previousSecretExpiresAt,
    graceSeconds,
    rotationActive: true,
  };

  if (generate) {
    result.secret = plaintext;
  }

  return result;
}

/**
 * Clear the previous secret early (end overlap before grace expiry).
 * Safe once all consumers have switched to the new secret.
 */
export async function finalizeWebhookSecretRotation(opts: {
  subscriptionId: string;
  talosId: string;
}): Promise<FinalizeResult | { error: string; status: number }> {
  const { subscriptionId, talosId } = opts;

  const [updated] = await db
    .update(tlsWebhookSubscriptions)
    .set({
      previousSecretCiphertext: null,
      previousSecretExpiresAt: null,
    })
    .where(
      and(
        eq(tlsWebhookSubscriptions.id, subscriptionId),
        eq(tlsWebhookSubscriptions.talosId, talosId),
      ),
    )
    .returning({ id: tlsWebhookSubscriptions.id });

  if (!updated) {
    return { error: "Subscription not found", status: 404 };
  }

  logger.info(
    { subscriptionId, talosId },
    "webhook_secret_rotation_finalized",
  );

  return {
    id: updated.id,
    previousSecretCleared: true,
    rotationActive: false,
  };
}
