/**
 * Single webhook subscription management API.
 *
 * GET    /api/webhooks/subscriptions/:id  — Get subscription details
 * PATCH  /api/webhooks/subscriptions/:id  — Update subscription
 * DELETE /api/webhooks/subscriptions/:id  — Delete subscription
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookSubscriptions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { parseBody } from "@/lib/schemas";
import { encryptSecret } from "@/lib/webhooks/signing";

// ─── Auth helper ─────────────────────────────────────────────────

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

const updateSubscriptionSchema = z
  .object({
    url: z.string().url().max(2048).optional(),
    secret: z.string().min(16).max(256).optional(),
    eventTypes: z.array(z.string().min(1)).min(1).optional(),
    description: z.string().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// ─── GET /api/webhooks/subscriptions/:id ─────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const subscription = await db
      .select({
        id: tlsWebhookSubscriptions.id,
        url: tlsWebhookSubscriptions.url,
        eventTypes: tlsWebhookSubscriptions.eventTypes,
        description: tlsWebhookSubscriptions.description,
        active: tlsWebhookSubscriptions.active,
        signatureVersion: tlsWebhookSubscriptions.signatureVersion,
        createdAt: tlsWebhookSubscriptions.createdAt,
        updatedAt: tlsWebhookSubscriptions.updatedAt,
      })
      .from(tlsWebhookSubscriptions)
      .where(
        and(
          eq(tlsWebhookSubscriptions.id, id),
          eq(tlsWebhookSubscriptions.talosId, callerTalosId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!subscription) {
      return Response.json({ error: "Subscription not found" }, { status: 404 });
    }

    return Response.json(subscription);
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "get_webhook_subscription_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── PATCH /api/webhooks/subscriptions/:id ───────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, updateSubscriptionSchema);
    if (error) return error;

    // Build update payload
    const updateData: Record<string, unknown> = {};

    if (data.url !== undefined) updateData.url = data.url;
    if (data.eventTypes !== undefined) updateData.eventTypes = data.eventTypes;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.active !== undefined) updateData.active = data.active;

    // Encrypt new secret if provided
    if (data.secret !== undefined) {
      try {
        updateData.secretCiphertext = encryptSecret(data.secret);
        // Increment signature version on secret rotation
        updateData.signatureVersion = 1;
      } catch (err) {
        logger.error({ err }, "webhook_secret_encrypt_failed");
        return Response.json(
          { error: "Failed to encrypt webhook secret" },
          { status: 500 },
        );
      }
    }

    const [updated] = await db
      .update(tlsWebhookSubscriptions)
      .set(updateData as any)
      .where(
        and(
          eq(tlsWebhookSubscriptions.id, id),
          eq(tlsWebhookSubscriptions.talosId, callerTalosId),
        ),
      )
      .returning({
        id: tlsWebhookSubscriptions.id,
        url: tlsWebhookSubscriptions.url,
        eventTypes: tlsWebhookSubscriptions.eventTypes,
        description: tlsWebhookSubscriptions.description,
        active: tlsWebhookSubscriptions.active,
        signatureVersion: tlsWebhookSubscriptions.signatureVersion,
        createdAt: tlsWebhookSubscriptions.createdAt,
        updatedAt: tlsWebhookSubscriptions.updatedAt,
      });

    if (!updated) {
      return Response.json({ error: "Subscription not found" }, { status: 404 });
    }

    logger.info(
      { subscriptionId: id, talosId: callerTalosId, updatedFields: Object.keys(data) },
      "webhook_subscription_updated",
    );

    return Response.json(updated);
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "update_webhook_subscription_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── DELETE /api/webhooks/subscriptions/:id ──────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const [deleted] = await db
      .delete(tlsWebhookSubscriptions)
      .where(
        and(
          eq(tlsWebhookSubscriptions.id, id),
          eq(tlsWebhookSubscriptions.talosId, callerTalosId),
        ),
      )
      .returning({ id: tlsWebhookSubscriptions.id });

    if (!deleted) {
      return Response.json({ error: "Subscription not found" }, { status: 404 });
    }

    logger.info(
      { subscriptionId: id, talosId: callerTalosId },
      "webhook_subscription_deleted",
    );

    return Response.json({ deleted: true, id }, { status: 200 });
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "delete_webhook_subscription_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
