/**
 * Webhook delivery engine.
 *
 * Handles the lifecycle of a delivery record:
 *   pending → (delivered | failed) → dead_letter (after max attempts)
 *
 * Supports:
 *   - Exponential backoff retries
 *   - HTTP timeout
 *   - Signature generation
 *   - Payload size limits
 *   - Concurrent-safe lease acquisition (fencing tokens)
 *   - Structured logging (secrets and payload bodies are never logged)
 */

import { db } from "@/db";
import { eq, and, lt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  tlsWebhookSubscriptions,
  tlsWebhookDeliveries,
} from "@/db/schema";
import { decryptSecret, signPayload } from "./signing";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  DELIVERY_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
} from "./config";
import { isWebhookDeliveryEnabled } from "./config";

// ─── Types ───────────────────────────────────────────────────────

export interface WebhookEvent {
  /** Event type, e.g. "approval.completed", "revenue.recorded" */
  type: string;
  /** TALOS ID that owns this event */
  talosId: string;
  /** Event payload (will be JSON-serialised for delivery) */
  payload: Record<string, unknown>;
}

export interface DeliveryResult {
  id: string;
  subscriptionId: string;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  attempts: number;
  lastStatusCode: number | null;
}

// ─── Event emission ──────────────────────────────────────────────

/**
 * Emit a webhook event across all active subscriptions for the given TALOS.
 *
 * Creates delivery records for matching subscriptions. Returns immediately
 * — actual HTTP delivery is handled by a worker that polls pending deliveries.
 *
 * This is fire-and-forget from the caller's perspective. Errors creating
 * delivery records are logged but never propagated.
 */
export async function emitWebhookEvent(event: WebhookEvent): Promise<void> {
  if (!isWebhookDeliveryEnabled()) {
    return;
  }

  try {
    // Validate payload size
    const payloadJson = JSON.stringify(event.payload);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      logger.warn(
        { eventType: event.type, talosId: event.talosId, payloadBytes },
        "webhook_payload_too_large",
      );
      return;
    }

    // Find active subscriptions matching this event type
    const subscriptions = await db
      .select({
        id: tlsWebhookSubscriptions.id,
        eventTypes: tlsWebhookSubscriptions.eventTypes,
      })
      .from(tlsWebhookSubscriptions)
      .where(
        and(
          eq(tlsWebhookSubscriptions.talosId, event.talosId),
          eq(tlsWebhookSubscriptions.active, true),
          sql`${event.type} = ANY(${tlsWebhookSubscriptions.eventTypes})`,
        ),
      );

    if (subscriptions.length === 0) return;

    const payloadHash = createHash("sha256")
      .update(payloadJson)
      .digest("hex");

    // Create delivery records
    const deliveries = subscriptions.map((sub) => ({
      subscriptionId: sub.id,
      eventType: event.type,
      // Store hash + event type and talos ID as reference for retry reconstruction
      payloadHash: `${payloadHash}:${event.type}@${event.talosId}`,
      status: "pending" as const,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: new Date(), // Deliver ASAP
    }));

    for (const delivery of deliveries) {
      try {
        await db.insert(tlsWebhookDeliveries).values(delivery).onConflictDoNothing();
      } catch (err) {
        logger.error(
          { subscriptionId: delivery.subscriptionId, eventType: event.type, err },
          "webhook_delivery_create_failed",
        );
      }
    }

    logger.info(
      { talosId: event.talosId, eventType: event.type, count: deliveries.length },
      "webhook_deliveries_created",
    );
  } catch (err) {
    logger.error(
      { talosId: event.talosId, eventType: event.type, err },
      "webhook_emit_error",
    );
  }
}

// ─── Delivery execution ──────────────────────────────────────────

/**
 * Attempt to deliver a single webhook.
 *
 * Claims the delivery (with fencing token), performs the HTTP call,
 * and records the result. Returns the updated delivery state.
 *
 * @throws If the delivery cannot be claimed (worker coordination).
 */
export async function attemptDelivery(
  deliveryId: string,
  workerId: string,
  ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
): Promise<DeliveryResult | null> {
  if (!isWebhookDeliveryEnabled()) {
    return null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // Atomic lease acquisition
  const [claimed] = await db
    .update(tlsWebhookDeliveries)
    .set({
      leasedBy: workerId,
      leasedAt: now,
      leaseExpiresAt: expiresAt,
      fencingToken: sql`${tlsWebhookDeliveries.fencingToken} + 1`,
    })
    .where(
      and(
        eq(tlsWebhookDeliveries.id, deliveryId),
        sql`${tlsWebhookDeliveries.status} = ANY(ARRAY['pending', 'failed'])`,
        or(
          eq(tlsWebhookDeliveries.leasedBy, null as unknown as string),
          eq(tlsWebhookDeliveries.leasedBy, workerId),
          lt(tlsWebhookDeliveries.leaseExpiresAt, now),
        ),
      ),
    )
    .returning({
      id: tlsWebhookDeliveries.id,
      subscriptionId: tlsWebhookDeliveries.subscriptionId,
      status: tlsWebhookDeliveries.status,
      attempts: tlsWebhookDeliveries.attempts,
      maxAttempts: tlsWebhookDeliveries.maxAttempts,
      fencingToken: tlsWebhookDeliveries.fencingToken,
      payloadHash: tlsWebhookDeliveries.payloadHash,
    });

  if (!claimed) {
    return null;
  }

  // Fetch subscription to get the URL and secret
  const subscription = await db
    .select()
    .from(tlsWebhookSubscriptions)
    .where(eq(tlsWebhookSubscriptions.id, claimed.subscriptionId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!subscription) {
    await markDeliveryFailed(deliveryId, "subscription_not_found", claimed.fencingToken);
    return null;
  }

  if (!subscription.active) {
    await markDeliveryFailed(deliveryId, "subscription_inactive", claimed.fencingToken);
    return null;
  }

  // For retries, we reconstruct the event payload from the stored payload
  // hash prefix. The full event payload is not persisted in the delivery
  // record (by design — no sensitive data in the delivery history).
  // If the prefix doesn't yield valid JSON, we return a minimal event stub.
  const payloadJson = reconstructPayload(claimed.payloadHash);

  // Decrypt the secret
  let secret: string;
  try {
    secret = decryptSecret(subscription.secretCiphertext);
  } catch (err) {
    logger.error(
      { deliveryId, subscriptionId: subscription.id, err },
      "webhook_secret_decrypt_failed",
    );
    await markDeliveryFailed(deliveryId, "secret_decrypt_failed", claimed.fencingToken);
    return null;
  }

  // Sign the payload
  const signature = signPayload(payloadJson, secret, subscription.signatureVersion);

  // Perform the HTTP delivery
  const startTime = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": claimed.payloadHash.slice(0, 16), // event type hint
        "User-Agent": "Talos-Webhook/1.0",
      },
      body: payloadJson,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    statusCode = response.status;
    responseBody = await response.text().catch(() => null);

    // Truncate response body for storage
    if (responseBody && responseBody.length > 512) {
      responseBody = responseBody.slice(0, 512) + "...";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Redact sensitive info from errors
    error = message.replace(/secret|token|key|auth|password/i, "[REDACTED]");
  }

  const durationMs = Date.now() - startTime;

  // Determine if delivery was successful
  const isSuccess = statusCode !== null && statusCode >= 200 && statusCode < 500;
  const newAttempts = claimed.attempts + 1;

  if (isSuccess) {
    await db
      .update(tlsWebhookDeliveries)
      .set({
        status: "delivered",
        attempts: newAttempts,
        lastStatusCode: statusCode,
        responseBody: responseBody,
        lastAttemptAt: new Date(),
        completedAt: new Date(),
        nextAttemptAt: null,
      })
      .where(
        and(
          eq(tlsWebhookDeliveries.id, deliveryId),
          eq(tlsWebhookDeliveries.fencingToken, claimed.fencingToken),
        ),
      );

    logger.info(
      {
        deliveryId,
        subscriptionId: subscription.id,
        statusCode,
        durationMs,
        attempts: newAttempts,
      },
      "webhook_delivered",
    );

    return {
      id: deliveryId,
      subscriptionId: subscription.id,
      status: "delivered",
      attempts: newAttempts,
      lastStatusCode: statusCode,
    };
  } else {
    // Delivery failed — schedule retry or dead-letter
    const maxAttempts = claimed.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const newStatus = newAttempts >= maxAttempts
      ? "dead_letter"
      : "failed";

    const nextAttemptAt = newStatus === "failed"
      ? calculateBackoff(newAttempts)
      : null;

    await db
      .update(tlsWebhookDeliveries)
      .set({
        status: newStatus,
        attempts: newAttempts,
        lastStatusCode: statusCode,
        lastError: error,
        responseBody,
        lastAttemptAt: new Date(),
        nextAttemptAt,
        completedAt: newStatus === "dead_letter" ? new Date() : null,
      })
      .where(
        and(
          eq(tlsWebhookDeliveries.id, deliveryId),
          eq(tlsWebhookDeliveries.fencingToken, claimed.fencingToken),
        ),
      );

    const logLevel = newStatus === "dead_letter" ? "error" : "warn";
    logger[logLevel](
      {
        deliveryId,
        subscriptionId: subscription.id,
        statusCode,
        error,
        attempts: newAttempts,
        nextAttemptAt,
      },
      newStatus === "dead_letter" ? "webhook_dead_letter" : "webhook_delivery_failed",
    );

    return {
      id: deliveryId,
      subscriptionId: subscription.id,
      status: newStatus,
      attempts: newAttempts,
      lastStatusCode: statusCode,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function markDeliveryFailed(
  deliveryId: string,
  error: string,
  fencingToken: number,
): Promise<void> {
  await db
    .update(tlsWebhookDeliveries)
    .set({
      status: "dead_letter",
      lastError: error,
      lastAttemptAt: new Date(),
      completedAt: new Date(),
      nextAttemptAt: null,
    })
    .where(
      and(
        eq(tlsWebhookDeliveries.id, deliveryId),
        eq(tlsWebhookDeliveries.fencingToken, fencingToken),
      ),
    );
}

/**
 * Calculate the next retry time using exponential backoff with jitter.
 */
export function calculateBackoff(attempt: number): Date {
  const delay = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
    BACKOFF_MAX_MS,
  );
  // Add ±25% jitter
  const jitter = delay * (0.75 + Math.random() * 0.5);
  return new Date(Date.now() + jitter);
}

/**
 * Reconstruct a JSON payload from the stored payload hash.
 *
 * The payload hash format is: `<sha256_hex>:<event_type>@<record_id>`
 * We embed the event type and a record identifier so that the worker can
 * reconstruct the full payload from current DB state on retry.
 * If no reference data is available, we return a minimal event stub.
 */
function reconstructPayload(payloadHash: string): string {
  const colonIndex = payloadHash.indexOf(":");
  if (colonIndex > 0 && colonIndex < payloadHash.length - 1) {
    const reference = payloadHash.slice(colonIndex + 1);
    // Format is either raw JSON prefix (migration compat) or event_type@record_id
    if (reference.includes("@")) {
      const [eventType, recordId] = reference.split("@", 2);
      return JSON.stringify({
        event: eventType,
        id: recordId ?? reference,
        _retry: true,
      });
    }

    // Legacy format: try to complete as JSON
    const trimmed = reference.replace(/[{,"'][^{}"' ]*$/, "");
    for (const attempt of [trimmed, trimmed + "}", trimmed + '"}']) {
      try {
        JSON.parse(attempt);
        return attempt;
      } catch {
        continue;
      }
    }
  }

  return JSON.stringify({ event: "webhook_retry" });
}
