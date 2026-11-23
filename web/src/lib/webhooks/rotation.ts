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
import { decryptSecret, deriveSigningKeyId, encryptSecret, type SigningKey } from "./signing";

export interface RotationResult {
  id: string;
  secretRotatedAt: Date;
  previousSecretExpiresAt: Date;
  overlapExpiresAt: Date;
  graceSeconds: number;
  overlapSeconds: number;
  activeKeyId: string;
  previousKeyId: string | null;
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
  /** Ordered signing keys with deterministic key identifiers. */
  keys: SigningKey[];
  /** Key identifier for the active (current) signing secret. */
  activeKeyId: string;
  /** Key identifier for the overlapping previous secret, or null if inactive/expired. */
  previousKeyId: string | null;
  /** Expiration timestamp of the overlap window, or null when not rotating. */
  overlapExpiresAt: Date | null;
  signatureVersion: number;
  rotationActive: boolean;
}

export type OverlapValidationResult =
  | { ok: true; seconds: number }
  | { ok: false; error: string };

/**
 * Validate a requested rotation overlap interval against configured bounds.
 *
 * When omitted (`undefined`), returns `DEFAULT_SECRET_ROTATION_GRACE_SECONDS`.
 * Explicit values outside `[MIN_SECRET_ROTATION_GRACE_SECONDS, MAX_SECRET_ROTATION_GRACE_SECONDS]`
 * or non-integers are rejected so callers cannot accidentally create unbounded
 * or zero-length overlap windows.
 */
export function validateOverlapSeconds(
  raw: number | undefined,
): OverlapValidationResult {
  if (raw === undefined) {
    return { ok: true, seconds: DEFAULT_SECRET_ROTATION_GRACE_SECONDS };
  }
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    return {
      ok: false,
      error: `Overlap interval must be an integer between ${MIN_SECRET_ROTATION_GRACE_SECONDS} and ${MAX_SECRET_ROTATION_GRACE_SECONDS} seconds`,
    };
  }
  if (raw < MIN_SECRET_ROTATION_GRACE_SECONDS || raw > MAX_SECRET_ROTATION_GRACE_SECONDS) {
    return {
      ok: false,
      error: `Overlap interval must be between ${MIN_SECRET_ROTATION_GRACE_SECONDS} and ${MAX_SECRET_ROTATION_GRACE_SECONDS} seconds`,
    };
  }
  return { ok: true, seconds: raw };
}

/** Generate a webhook signing secret (`whsec_` + 32 random bytes hex). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/**
 * Resolve the plaintext secrets and key identifiers that should sign an outbound delivery.
 * Expired previous secrets are omitted (lazy expiry — no write required).
 */
export function resolveSigningSecrets(
  subscription: {
    secretCiphertext: string;
    previousSecretCiphertext?: string | null;
    previousSecretExpiresAt?: Date | null;
    signatureVersion: number;
  },
  now: Date = new Date(),
): SigningSecretBundle {
  const currentSecret = decryptSecret(subscription.secretCiphertext);
  const activeKeyId = deriveSigningKeyId(currentSecret);
  const secrets: string[] = [currentSecret];
  const keys: SigningKey[] = [{ id: activeKeyId, secret: currentSecret }];
  let previousKeyId: string | null = null;
  let overlapExpiresAt: Date | null = null;
  let rotationActive = false;

  const prevCipher = subscription.previousSecretCiphertext;
  const expiresAt = subscription.previousSecretExpiresAt;
  if (prevCipher && expiresAt && expiresAt.getTime() > now.getTime()) {
    try {
      const previousSecret = decryptSecret(prevCipher);
      const prevId = deriveSigningKeyId(previousSecret);
      secrets.push(previousSecret);
      keys.push({ id: prevId, secret: previousSecret });
      previousKeyId = prevId;
      overlapExpiresAt = expiresAt;
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
    keys,
    activeKeyId,
    previousKeyId,
    overlapExpiresAt,
    signatureVersion: subscription.signatureVersion,
    rotationActive,
  };
}

/**
 * Rotate the signing secret for a subscription.
 *
 * Moves the current ciphertext into the previous slot (with bounded overlap expiry)
 * and installs the new secret as current. Delivery dual-signs until expiry.
 */
export async function rotateWebhookSecret(opts: {
  subscriptionId: string;
  talosId: string;
  newSecret?: string;
  generate?: boolean;
  graceSeconds?: number;
  overlapSeconds?: number;
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

  const requestedOverlap = opts.overlapSeconds ?? opts.graceSeconds;
  const overlapValidation = validateOverlapSeconds(requestedOverlap);
  if (!overlapValidation.ok) {
    return { error: overlapValidation.error, status: 400 };
  }

  const graceSeconds = overlapValidation.seconds;
  const now = new Date();
  const previousSecretExpiresAt = new Date(now.getTime() + graceSeconds * 1000);
  const activeKeyId = deriveSigningKeyId(plaintext);

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

  let previousKeyId: string | null = null;
  try {
    previousKeyId = deriveSigningKeyId(decryptSecret(existing.secretCiphertext));
  } catch {
    previousKeyId = null;
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
      activeKeyId,
      previousKeyId,
      previousSecretExpiresAt: updated.previousSecretExpiresAt.toISOString(),
    },
    "webhook_secret_rotated",
  );

  const result: RotationResult = {
    id: updated.id,
    secretRotatedAt: updated.secretRotatedAt,
    previousSecretExpiresAt: updated.previousSecretExpiresAt,
    overlapExpiresAt: updated.previousSecretExpiresAt,
    graceSeconds,
    overlapSeconds: graceSeconds,
    activeKeyId,
    previousKeyId,
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
