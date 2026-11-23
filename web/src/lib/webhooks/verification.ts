/**
 * Destination verification handshake for webhook subscriptions.
 *
 * Verifies control of a configured destination URL before enabling deliveries.
 * Preserves SSRF protections (via validateUrl & safeFetch) and bounds
 * verification lifetime (challenge TTL and verification expiration).
 */

import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { tlsWebhookSubscriptions } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { safeFetch, validateUrl } from "@/lib/security/ssrf";
import { decryptSecret, signPayload } from "./signing";
import {
  WEBHOOK_VERIFICATION_CHALLENGE_TTL_SECONDS,
  WEBHOOK_VERIFICATION_TIMEOUT_MS,
  WEBHOOK_VERIFICATION_TTL_SECONDS,
} from "./config";
import type { NextRequest } from "next/server";
import type { z } from "zod/v4";

export type DestinationVerificationStatus = "pending" | "verified" | "failed" | "expired";

export interface DestinationHandshakeOptions {
  subscriptionId: string;
  talosId: string;
  url: string;
  secretCiphertext?: string;
  secretPlaintext?: string;
  signatureVersion?: number;
  challengeTtlSeconds?: number;
  verificationTtlSeconds?: number;
  timeoutMs?: number;
}

export interface DestinationHandshakeResult {
  success: boolean;
  status: DestinationVerificationStatus;
  challenge: string;
  statusCode?: number | null;
  error?: string | null;
  verifiedAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * Generate a cryptographically random verification challenge token.
 */
export function generateVerificationToken(): string {
  return `whver_${randomBytes(24).toString("hex")}`;
}

/**
 * Check whether a webhook subscription has verified control of its destination URL
 * and its verification has not expired.
 *
 * For backward compatibility with subscriptions created prior to destination verification,
 * subscriptions where `destinationVerificationStatus` is null/undefined are treated as verified.
 */
export function isSubscriptionDestinationVerified(sub: {
  destinationVerificationStatus?: string | null;
  destinationVerifiedAt?: Date | null;
  destinationVerificationExpiresAt?: Date | null;
}): boolean {
  // Legacy compatibility: subscriptions created without verification status remain functional
  if (sub.destinationVerificationStatus === undefined || sub.destinationVerificationStatus === null) {
    return true;
  }

  if (sub.destinationVerificationStatus !== "verified") {
    return false;
  }

  // Bounded verification lifetime check
  if (sub.destinationVerificationExpiresAt && sub.destinationVerificationExpiresAt.getTime() <= Date.now()) {
    return false;
  }

  return true;
}

/**
 * Perform the outbound destination verification handshake.
 *
 * Sends a signed verification challenge to the configured URL using `safeFetch`
 * to enforce SSRF boundaries, requiring the destination to echo the challenge in a 2xx response.
 */
export async function performDestinationHandshake(
  options: DestinationHandshakeOptions,
): Promise<DestinationHandshakeResult> {
  const challenge = generateVerificationToken();
  const challengeTtl = options.challengeTtlSeconds ?? WEBHOOK_VERIFICATION_CHALLENGE_TTL_SECONDS;
  const verificationTtl = options.verificationTtlSeconds ?? WEBHOOK_VERIFICATION_TTL_SECONDS;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_VERIFICATION_TIMEOUT_MS;
  const challengeExpiresAt = new Date(Date.now() + challengeTtl * 1000);

  // 1. SSRF Protection: Validate destination URL before any network operation
  try {
    await validateUrl(options.url);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid destination URL";
    logger.warn(
      { subscriptionId: options.subscriptionId, url: options.url, err: message },
      "webhook_handshake_ssrf_rejected",
    );
    return {
      success: false,
      status: "failed",
      challenge,
      error: `SSRF validation failed: ${message}`,
    };
  }

  // 2. Resolve signing secret
  let secret = options.secretPlaintext;
  if (!secret && options.secretCiphertext) {
    try {
      secret = decryptSecret(options.secretCiphertext);
    } catch (err) {
      logger.error(
        { subscriptionId: options.subscriptionId, err },
        "webhook_handshake_secret_decrypt_failed",
      );
      return {
        success: false,
        status: "failed",
        challenge,
        error: "Failed to decrypt webhook secret",
      };
    }
  }

  // 3. Construct and sign verification payload
  const payload = JSON.stringify({
    type: "endpoint.verification",
    challenge,
    subscriptionId: options.subscriptionId,
    talosId: options.talosId,
    timestamp: Math.floor(Date.now() / 1000),
  });

  const signature = secret
    ? signPayload(payload, secret, options.signatureVersion ?? 1)
    : "";

  // 4. Perform bounded HTTP handshake via safeFetch
  let statusCode: number | null = null;
  let responseText: string | null = null;
  let networkError: string | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await safeFetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": "endpoint.verification",
        "X-Webhook-Challenge": challenge,
        "User-Agent": "Talos-Webhook-Verification/1.0",
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    statusCode = response.status;
    responseText = await response.text().catch(() => null);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    networkError = rawMsg.replace(/secret|token|key|auth|password/i, "[REDACTED]");
  }

  // 5. Verify that destination echoed the challenge
  let challengeEchoed = false;
  if (statusCode !== null && statusCode >= 200 && statusCode < 300 && responseText) {
    try {
      const json = JSON.parse(responseText);
      if (json && typeof json === "object" && json.challenge === challenge) {
        challengeEchoed = true;
      }
    } catch {
      if (responseText.trim() === challenge) {
        challengeEchoed = true;
      }
    }
  }

  // 6. Record state transition
  if (challengeEchoed) {
    const verifiedAt = new Date();
    const expiresAt = new Date(Date.now() + verificationTtl * 1000);

    if (options.subscriptionId) {
      await db
        .update(tlsWebhookSubscriptions)
        ?.set({
          destinationVerificationStatus: "verified",
          destinationVerifiedAt: verifiedAt,
          destinationVerificationExpiresAt: expiresAt,
          destinationVerificationToken: null,
        })
        ?.where(
          and(
            eq(tlsWebhookSubscriptions.id, options.subscriptionId),
            eq(tlsWebhookSubscriptions.talosId, options.talosId),
          ),
        );
    }

    logger.info(
      { subscriptionId: options.subscriptionId, talosId: options.talosId, statusCode },
      "webhook_destination_handshake_verified",
    );

    return {
      success: true,
      status: "verified",
      challenge,
      statusCode,
      verifiedAt,
      expiresAt,
    };
  } else {
    const errorMsg = networkError
      ? networkError
      : statusCode !== null && (statusCode < 200 || statusCode >= 300)
        ? `Destination returned HTTP status ${statusCode}`
        : "Destination response did not echo verification challenge";

    if (options.subscriptionId) {
      await db
        .update(tlsWebhookSubscriptions)
        ?.set({
          destinationVerificationStatus: "failed",
          destinationVerificationToken: challenge,
          destinationVerificationExpiresAt: challengeExpiresAt,
        })
        ?.where(
          and(
            eq(tlsWebhookSubscriptions.id, options.subscriptionId),
            eq(tlsWebhookSubscriptions.talosId, options.talosId),
          ),
        );
    }

    logger.warn(
      { subscriptionId: options.subscriptionId, talosId: options.talosId, statusCode, reason: errorMsg },
      "webhook_destination_handshake_failed",
    );

    return {
      success: false,
      status: "failed",
      challenge,
      statusCode,
      error: errorMsg,
    };
  }
}

/**
 * Manually verify a subscription using a previously issued challenge token.
 */
export async function verifySubscriptionChallengeToken(options: {
  subscriptionId: string;
  talosId: string;
  token: string;
  verificationTtlSeconds?: number;
}): Promise<DestinationHandshakeResult> {
  const verificationTtl = options.verificationTtlSeconds ?? WEBHOOK_VERIFICATION_TTL_SECONDS;

  const subscription = await db
    .select({
      id: tlsWebhookSubscriptions.id,
      destinationVerificationToken: tlsWebhookSubscriptions.destinationVerificationToken,
      destinationVerificationExpiresAt: tlsWebhookSubscriptions.destinationVerificationExpiresAt,
    })
    .from(tlsWebhookSubscriptions)
    .where(
      and(
        eq(tlsWebhookSubscriptions.id, options.subscriptionId),
        eq(tlsWebhookSubscriptions.talosId, options.talosId),
      ),
    )
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!subscription) {
    return {
      success: false,
      status: "failed",
      challenge: options.token,
      error: "Subscription not found",
    };
  }

  const now = Date.now();
  const tokenMatches =
    subscription.destinationVerificationToken &&
    subscription.destinationVerificationToken === options.token;

  const notExpired =
    subscription.destinationVerificationExpiresAt &&
    subscription.destinationVerificationExpiresAt.getTime() > now;

  if (!tokenMatches || !notExpired) {
    return {
      success: false,
      status: "failed",
      challenge: options.token,
      error: !notExpired
        ? "Verification challenge has expired"
        : "Invalid verification challenge token",
    };
  }

  const verifiedAt = new Date();
  const expiresAt = new Date(now + verificationTtl * 1000);

  await db
    .update(tlsWebhookSubscriptions)
    .set({
      destinationVerificationStatus: "verified",
      destinationVerifiedAt: verifiedAt,
      destinationVerificationExpiresAt: expiresAt,
      destinationVerificationToken: null,
    })
    .where(
      and(
        eq(tlsWebhookSubscriptions.id, options.subscriptionId),
        eq(tlsWebhookSubscriptions.talosId, options.talosId),
      ),
    );

  logger.info(
    { subscriptionId: options.subscriptionId, talosId: options.talosId },
    "webhook_destination_token_verified",
  );

  return {
    success: true,
    status: "verified",
    challenge: options.token,
    verifiedAt,
    expiresAt,
  };
}

/**
 * Parse JSON request body with a Zod schema without relying on the root schemas module.
 */
export async function parseJsonBody<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
): Promise<{ data: z.infer<T>; error?: never } | { data?: never; error: Response }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { error: Response.json({ error: "Invalid JSON" }, { status: 400 }) };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      error: Response.json(
        {
          error: "Validation failed",
          issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        },
        { status: 400 },
      ),
    };
  }

  return { data: result.data };
}
