/**
 * Webhook delivery management API.
 *
 * GET /api/webhooks/deliveries  — List recent deliveries for the authenticated TALOS
 * GET /api/webhooks/deliveries/pending  — Get pending deliveries (for worker polling)
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookSubscriptions, tlsWebhookDeliveries } from "@/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";

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

// ─── Helper: get subscription IDs belonging to a TALOS ───────────

async function getSubscriptionIds(talosId: string): Promise<string[]> {
  const subs = await db
    .select({ id: tlsWebhookSubscriptions.id })
    .from(tlsWebhookSubscriptions)
    .where(eq(tlsWebhookSubscriptions.talosId, talosId));
  return subs.map((s) => s.id);
}

// ─── GET /api/webhooks/deliveries ────────────────────────────────

const listDeliveriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  status: z.string().optional(),
  cursor: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listDeliveriesSchema.safeParse(searchParams);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid query parameters" },
        { status: 400 },
      );
    }

    const { limit, status, cursor } = parsed.data;

    // Get subscription IDs for this TALOS
    const subscriptionIds = await getSubscriptionIds(callerTalosId);
    if (subscriptionIds.length === 0) {
      return Response.json({ data: [], nextCursor: null });
    }

    // Build conditions
    const conditions = [inArray(tlsWebhookDeliveries.subscriptionId, subscriptionIds)];
    if (status) {
      conditions.push(eq(tlsWebhookDeliveries.status, status));
    }
    if (cursor) {
      conditions.push(eq(tlsWebhookDeliveries.id, cursor));
    }

    const deliveries = await db
      .select({
        id: tlsWebhookDeliveries.id,
        subscriptionId: tlsWebhookDeliveries.subscriptionId,
        eventType: tlsWebhookDeliveries.eventType,
        status: tlsWebhookDeliveries.status,
        attempts: tlsWebhookDeliveries.attempts,
        maxAttempts: tlsWebhookDeliveries.maxAttempts,
        lastStatusCode: tlsWebhookDeliveries.lastStatusCode,
        lastError: tlsWebhookDeliveries.lastError,
        lastAttemptAt: tlsWebhookDeliveries.lastAttemptAt,
        nextAttemptAt: tlsWebhookDeliveries.nextAttemptAt,
        completedAt: tlsWebhookDeliveries.completedAt,
        createdAt: tlsWebhookDeliveries.createdAt,
      })
      .from(tlsWebhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(tlsWebhookDeliveries.createdAt))
      .limit(limit + 1);

    const hasMore = deliveries.length > limit;
    const page = hasMore ? deliveries.slice(0, limit) : deliveries;
    const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null;

    return Response.json({ data: page, nextCursor });
  } catch (err) {
    logger.error({ err }, "list_webhook_deliveries_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
