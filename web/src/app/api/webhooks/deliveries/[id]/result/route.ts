/**
 * POST /api/webhooks/deliveries/:id/result
 *
 * Submits the result of a webhook delivery attempt and releases the lease.
 * Uses the same fencing-token pattern as commerce jobs.
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookDeliveries } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { DEFAULT_MAX_ATTEMPTS } from "@/lib/webhooks/config";
import { calculateBackoff } from "@/lib/webhooks/delivery";

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

const submitResultSchema = z.object({
  statusCode: z.number().int().nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
  responseBody: z.string().max(1024).nullable().optional(),
  fencingToken: z.number().int().nonnegative(),
});

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

    let body: z.infer<typeof submitResultSchema>;
    try {
      body = submitResultSchema.parse(await request.json());
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { statusCode, error, responseBody, fencingToken } = body;

    // Fetch the current delivery
    const delivery = await db
      .select({
        id: tlsWebhookDeliveries.id,
        status: tlsWebhookDeliveries.status,
        attempts: tlsWebhookDeliveries.attempts,
        maxAttempts: tlsWebhookDeliveries.maxAttempts,
        fencingToken: tlsWebhookDeliveries.fencingToken,
      })
      .from(tlsWebhookDeliveries)
      .where(eq(tlsWebhookDeliveries.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!delivery) {
      return Response.json({ error: "Delivery not found" }, { status: 404 });
    }

    if (delivery.fencingToken !== fencingToken) {
      return Response.json(
        { error: "Fencing token mismatch", detail: "Lease may have been taken over by another worker" },
        { status: 409 },
      );
    }

    const sc = statusCode ?? 0;
    const isSuccess = sc >= 200 && sc < 500;
    const newAttempts = delivery.attempts + 1;
    const newStatus = isSuccess
      ? "delivered"
      : newAttempts >= (delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS)
        ? "dead_letter"
        : "failed";

    const nextAttemptAt = newStatus === "failed" ? calculateBackoff(newAttempts) : null;

    await db
      .update(tlsWebhookDeliveries)
      .set({
        status: newStatus,
        attempts: newAttempts,
        lastStatusCode: statusCode,
        lastError: error ?? null,
        responseBody: responseBody ?? null,
        lastAttemptAt: new Date(),
        nextAttemptAt,
        completedAt: newStatus !== "failed" ? new Date() : null,
        // Release the lease
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(tlsWebhookDeliveries.id, id),
          eq(tlsWebhookDeliveries.fencingToken, fencingToken),
        ),
      );

    const logLevel = newStatus === "dead_letter" ? "error" : newStatus === "delivered" ? "info" : "warn";
    logger[logLevel](
      { deliveryId: id, status: newStatus, attempts: newAttempts, statusCode, error },
      `webhook_delivery_${newStatus}`,
    );

    return Response.json({
      id,
      status: newStatus,
      attempts: newAttempts,
      nextAttemptAt,
    });
  } catch (err) {
    logger.error({ deliveryId: id, err }, "submit_webhook_delivery_result_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
