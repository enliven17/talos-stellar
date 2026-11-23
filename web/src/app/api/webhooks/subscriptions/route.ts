/**
 * Webhook subscription management API.
 *
 * POST /api/webhooks/subscriptions   — Create a new subscription
 * GET  /api/webhooks/subscriptions   — List subscriptions for the authenticated TALOS
 */

import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  tlsTalos,
  tlsWebhookSubscriptions,
} from "@/db/schema";
import { and, or, eq, desc, lt } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { encryptSecret } from "@/lib/webhooks/signing";
import { validateUrl } from "@/lib/security/ssrf";
import { parseJsonBody as parseBody, performDestinationHandshake } from "@/lib/webhooks/verification";

// ─── Auth helper (same pattern as jobs routes) ───────────────────

async function resolveCallerTalos(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const talos = await db
    .select({ id: tlsTalos.id })
    .from(tlsTalos)
    .where(eq(tlsTalos.apiKey, token))
    .limit(1)
    .then((r) => r[0] ?? null);
  return talos?.id ?? null;
}

// ─── Schemas ─────────────────────────────────────────────────────

const createSubscriptionSchema = z.object({
  url: z.string().url().max(2048),
  secret: z.string().min(16).max(256),
  eventTypes: z.array(z.string().min(1)).min(1),
  description: z.string().max(500).optional(),
});

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  active: z.coerce.boolean().optional(),
});

// ─── POST /api/webhooks/subscriptions ────────────────────────────

async function _POST(request: NextRequest) {
  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, createSubscriptionSchema);
    if (error) return error;

    try {
      await validateUrl(data.url);
    } catch (err) {
      return Response.json(
        { error: "Validation failed", issues: [`url: ${err instanceof Error ? err.message : "Invalid URL"}`] },
        { status: 400 }
      );
    }

    // Encrypt the secret at rest
    let secretCiphertext: string;
    try {
      secretCiphertext = encryptSecret(data.secret);
    } catch (err) {
      logger.error({ err }, "webhook_secret_encrypt_failed");
      return Response.json(
        { error: "Failed to encrypt webhook secret. Check WEBHOOK_SECRET_ENCRYPTION_KEY." },
        { status: 500 },
      );
    }

    const [subscription] = await db
      .insert(tlsWebhookSubscriptions)
      .values({
        talosId: callerTalosId,
        url: data.url,
        secretCiphertext,
        eventTypes: data.eventTypes,
        description: data.description ?? null,
        destinationVerificationStatus: "pending",
      })
      .returning();

    logger.info(
      { subscriptionId: subscription.id, talosId: callerTalosId, eventCount: data.eventTypes.length },
      "webhook_subscription_created",
    );

    // Destination verification handshake: deliveries stay disabled until the
    // destination echoes a signed challenge. Failure never fails creation; the
    // caller can retry via POST /api/webhooks/subscriptions/:id/verify.
    let verification: {
      status: string;
      verifiedAt: Date | null;
      expiresAt: Date | null;
      error: string | null;
    } = { status: "pending", verifiedAt: null, expiresAt: null, error: null };
    try {
      const result = await performDestinationHandshake({
        subscriptionId: subscription.id,
        talosId: callerTalosId,
        url: data.url,
        secretPlaintext: data.secret,
        signatureVersion: subscription.signatureVersion ?? 1,
      });
      verification = {
        status: result.status,
        verifiedAt: result.verifiedAt ?? null,
        expiresAt: result.expiresAt ?? null,
        error: result.error ?? null,
      };
    } catch (err) {
      logger.warn({ subscriptionId: subscription.id, err }, "webhook_destination_handshake_error");
      verification.error = "Destination verification could not be completed";
    }

    // Return the subscription without the secret
    return Response.json(
      {
        id: subscription.id,
        talosId: subscription.talosId,
        url: subscription.url,
        eventTypes: subscription.eventTypes,
        description: subscription.description,
        active: subscription.active,
        signatureVersion: subscription.signatureVersion,
        destinationVerification: verification,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      },
      { status: 201 },
    );
  } catch (err) {
    logger.error({ err }, "create_webhook_subscription_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── GET /api/webhooks/subscriptions ─────────────────────────────

async function _GET(request: NextRequest) {
  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listQuerySchema.safeParse(searchParams);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid query parameters", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { cursor, limit, active } = parsed.data;

    // Build dynamic conditions
    const whereConditions = [eq(tlsWebhookSubscriptions.talosId, callerTalosId)];
    if (active !== undefined) {
      whereConditions.push(eq(tlsWebhookSubscriptions.active, active));
    }

    if (cursor) {
      const [cursorDate, cursorId] = cursor.split("|");
      if (cursorDate && cursorId) {
        whereConditions.push(
          or(
            lt(tlsWebhookSubscriptions.createdAt, new Date(cursorDate)),
            and(
              eq(tlsWebhookSubscriptions.createdAt, new Date(cursorDate)),
              lt(tlsWebhookSubscriptions.id, cursorId),
            ),
          )!,
        );
      }
    }

    const subscriptions = await db
      .select({
        id: tlsWebhookSubscriptions.id,
        url: tlsWebhookSubscriptions.url,
        eventTypes: tlsWebhookSubscriptions.eventTypes,
        description: tlsWebhookSubscriptions.description,
        active: tlsWebhookSubscriptions.active,
        signatureVersion: tlsWebhookSubscriptions.signatureVersion,
        destinationVerificationStatus: tlsWebhookSubscriptions.destinationVerificationStatus,
        destinationVerifiedAt: tlsWebhookSubscriptions.destinationVerifiedAt,
        destinationVerificationExpiresAt: tlsWebhookSubscriptions.destinationVerificationExpiresAt,
        createdAt: tlsWebhookSubscriptions.createdAt,
        updatedAt: tlsWebhookSubscriptions.updatedAt,
      })
      .from(tlsWebhookSubscriptions)
      .where(and(...whereConditions))
      .orderBy(desc(tlsWebhookSubscriptions.createdAt), desc(tlsWebhookSubscriptions.id))
      .limit(limit + 1);

    const hasMore = subscriptions.length > limit;
    const page = hasMore ? subscriptions.slice(0, limit) : subscriptions;
    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem
      ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
      : null;

    return Response.json({ data: page, nextCursor });
  } catch (err) {
    logger.error({ err }, "list_webhook_subscriptions_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRequestId(_POST);
export const GET = withRequestId(_GET);
