/**
 * POST /api/webhooks/deliveries/:id/heartbeat
 *
 * Extends the lease on a claimed webhook delivery.
 * Uses the same fencing-token pattern as commerce jobs.
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookDeliveries } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { parseBody, heartbeatJobSchema } from "@/lib/schemas";
import { HEARTBEAT_EXTEND_SECONDS } from "@/lib/webhooks/config";

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
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const { data, error } = await parseBody(request, heartbeatJobSchema);
    if (error) return error;

    const now = new Date();
    const newExpiry = new Date(now.getTime() + HEARTBEAT_EXTEND_SECONDS * 1000);

    const [renewed] = await db
      .update(tlsWebhookDeliveries)
      .set({ leaseExpiresAt: newExpiry })
      .where(
        and(
          eq(tlsWebhookDeliveries.id, id),
          eq(tlsWebhookDeliveries.leasedBy, callerTalosId),
          eq(tlsWebhookDeliveries.fencingToken, data.fencingToken),
          sql`${tlsWebhookDeliveries.status} = ANY(ARRAY['pending', 'failed'])`,
        ),
      )
      .returning({ leaseExpiresAt: tlsWebhookDeliveries.leaseExpiresAt });

    if (!renewed) {
      return Response.json(
        {
          error: "Lease not held or fencing token mismatch",
          detail: "The delivery may have been taken over by another worker or the fencing token is stale",
        },
        { status: 409 },
      );
    }

    logger.info(
      { deliveryId: id, leasedBy: callerTalosId, expiresAt: renewed.leaseExpiresAt },
      "webhook_delivery_lease_renewed",
    );

    return Response.json({ renewed: true, leaseExpiresAt: renewed.leaseExpiresAt }, { status: 200 });
  } catch (err) {
    logger.error({ deliveryId: id, err }, "heartbeat_webhook_delivery_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
