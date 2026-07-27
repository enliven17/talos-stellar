/**
 * POST /api/webhooks/deliveries/:id/claim
 *
 * Acquires an exclusive lease on a webhook delivery. Uses the same
 * fencing-token pattern as commerce jobs for stale-worker protection.
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookDeliveries } from "@/db/schema";
import { eq, and, lt, or, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, claimJobSchema } from "@/lib/schemas";
import { isWebhookDeliveryEnabled, DEFAULT_LEASE_TTL_SECONDS } from "@/lib/webhooks/config";

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isWebhookDeliveryEnabled()) {
    return Response.json({ error: "Webhook delivery is disabled" }, { status: 503 });
  }

  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, claimJobSchema);
    if (error) return error;

    const ttlSeconds = data.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // Atomic lease acquisition
    const [claimed] = await db
      .update(tlsWebhookDeliveries)
      .set({
        leasedBy: callerTalosId,
        leasedAt: now,
        leaseExpiresAt: expiresAt,
        fencingToken: sql`${tlsWebhookDeliveries.fencingToken} + 1`,
      })
      .where(
        and(
          eq(tlsWebhookDeliveries.id, id),
          sql`${tlsWebhookDeliveries.status} = ANY(ARRAY['pending', 'failed'])`,
          or(
            eq(tlsWebhookDeliveries.leasedBy, callerTalosId),
            eq(tlsWebhookDeliveries.leasedBy, null as unknown as string),
            lt(tlsWebhookDeliveries.leaseExpiresAt, now),
          ),
        ),
      )
      .returning({
        id: tlsWebhookDeliveries.id,
        leasedBy: tlsWebhookDeliveries.leasedBy,
        leasedAt: tlsWebhookDeliveries.leasedAt,
        leaseExpiresAt: tlsWebhookDeliveries.leaseExpiresAt,
        fencingToken: tlsWebhookDeliveries.fencingToken,
        status: tlsWebhookDeliveries.status,
        subscriptionId: tlsWebhookDeliveries.subscriptionId,
      });

    if (!claimed) {
      const delivery = await db
        .select({ id: tlsWebhookDeliveries.id, status: tlsWebhookDeliveries.status })
        .from(tlsWebhookDeliveries)
        .where(eq(tlsWebhookDeliveries.id, id))
        .limit(1)
        .then((r) => r[0] ?? null);

      if (!delivery) {
        return Response.json({ error: "Delivery not found" }, { status: 404 });
      }

      return Response.json(
        { error: "Delivery is already claimed by another worker" },
        { status: 409 },
      );
    }

    logger.info(
      { deliveryId: id, leasedBy: callerTalosId, fencingToken: claimed.fencingToken },
      "webhook_delivery_claimed",
    );

    return Response.json(claimed, { status: 200 });
  } catch (err) {
    logger.error({ deliveryId: id, err }, "claim_webhook_delivery_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
