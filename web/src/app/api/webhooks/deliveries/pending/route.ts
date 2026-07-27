/**
 * GET /api/webhooks/deliveries/pending
 *
 * Returns pending webhook deliveries across all TALOSes for worker polling.
 * Uses the same lease-filtering pattern as GET /api/jobs/pending:
 *   - Not leased (null), OR
 *   - Leased by the caller, OR
 *   - Lease has expired (available for re-claim)
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookDeliveries } from "@/db/schema";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { z } from "zod/v4";
import { isWebhookDeliveryEnabled } from "@/lib/webhooks/config";

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

const pendingQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

// ─── GET /api/webhooks/deliveries/pending ────────────────────────

export async function GET(request: NextRequest) {
  if (!isWebhookDeliveryEnabled()) {
    return Response.json({
      jobs: [],
      nextCursor: null,
      disabled: true,
    });
  }

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = pendingQuerySchema.safeParse(searchParams);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid query parameters", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { cursor, limit } = parsed.data;
    const now = new Date();

    // Return deliveries that are:
    //   - pending or failed (retryable)
    //   - next_attempt_at is now or in the past
    //   - not leased, OR leased by this caller, OR lease expired
    const conditions = [
      sql`${tlsWebhookDeliveries.status} = ANY(ARRAY['pending', 'failed'])`,
      sql`(${tlsWebhookDeliveries.nextAttemptAt} IS NULL OR ${tlsWebhookDeliveries.nextAttemptAt} <= ${now})`,
      or(
        eq(tlsWebhookDeliveries.leasedBy, null as unknown as string),
        eq(tlsWebhookDeliveries.leasedBy, callerTalosId),
        lt(tlsWebhookDeliveries.leaseExpiresAt, now),
      ),
    ];

    if (cursor) {
      conditions.push(sql`${tlsWebhookDeliveries.createdAt} > ${new Date(cursor)}`);
    }

    const rows = await db
      .select()
      .from(tlsWebhookDeliveries)
      .where(and(...conditions))
      .orderBy(asc(tlsWebhookDeliveries.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const deliveries = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? deliveries[deliveries.length - 1]?.createdAt.toISOString() ?? null
      : null;

    logger.info(
      { talosId: callerTalosId, count: deliveries.length, hasMore },
      "pending_webhook_deliveries_fetched",
    );

    return Response.json({ jobs: deliveries, nextCursor });
  } catch (err) {
    logger.error({ err }, "pending_webhook_deliveries_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
