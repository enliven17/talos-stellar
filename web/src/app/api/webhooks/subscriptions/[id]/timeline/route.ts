/**
 * Webhook delivery timeline API.
 *
 * GET /api/webhooks/subscriptions/:id/timeline
 *
 * Returns a paginated, sanitized list of delivery attempts for a subscription
 * owned by the authenticated TALOS.  Each entry exposes:
 *
 *   – attemptedAt    — wall-clock time of the most recent delivery attempt
 *   – responseCategory — coarse outcome bucket (2xx / 3xx / 4xx / 5xx /
 *                        network_error / pending) derived from lastStatusCode
 *   – nextRetryAt    — when the next retry is scheduled (null if terminal)
 *   – attempts / maxAttempts / status — progress counters
 *
 * Never included: responseBody, payloadHash, leasedBy, leasedAt,
 * leaseExpiresAt, fencingToken.  These are either secret-adjacent or
 * implementation details that expose internal infrastructure.
 *
 * Pagination uses a createdAt-based cursor (ISO timestamp).  Pass the
 * returned nextCursor as ?cursor= on the next request.
 */

import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsWebhookSubscriptions, tlsWebhookDeliveries } from "@/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
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

// ─── Response category helper ─────────────────────────────────────

/**
 * Map an HTTP status code (or null) to a human-readable response category.
 * Null means the attempt never received an HTTP response (network/timeout).
 */
function toResponseCategory(
  statusCode: number | null,
  status: string,
): string {
  if (statusCode === null) {
    return status === "pending" ? "pending" : "network_error";
  }
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500) return "5xx";
  return "network_error";
}

// ─── Timeline entry type (safe to expose) ────────────────────────

export interface TimelineEntry {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  responseCategory: string;
  attemptedAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

// ─── Query schema ─────────────────────────────────────────────────

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

// ─── GET /api/webhooks/subscriptions/:id/timeline ────────────────

async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const callerTalosId = await resolveCallerTalos(request);
    if (!callerTalosId) {
      return Response.json({ error: "Missing or invalid Authorization" }, { status: 401 });
    }

    // Verify the subscription exists and belongs to this caller.
    const subscription = await db
      .select({ id: tlsWebhookSubscriptions.id })
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

    // Parse query params.
    const searchParams = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = querySchema.safeParse(searchParams);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid query parameters", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { cursor, limit } = parsed.data;

    const conditions = [eq(tlsWebhookDeliveries.subscriptionId, id)];
    if (cursor) {
      conditions.push(lt(tlsWebhookDeliveries.createdAt, new Date(cursor)));
    }

    // Fetch limit+1 to detect whether another page exists.
    const rows = await db
      .select({
        id: tlsWebhookDeliveries.id,
        eventType: tlsWebhookDeliveries.eventType,
        status: tlsWebhookDeliveries.status,
        attempts: tlsWebhookDeliveries.attempts,
        maxAttempts: tlsWebhookDeliveries.maxAttempts,
        lastStatusCode: tlsWebhookDeliveries.lastStatusCode,
        lastAttemptAt: tlsWebhookDeliveries.lastAttemptAt,
        nextAttemptAt: tlsWebhookDeliveries.nextAttemptAt,
        createdAt: tlsWebhookDeliveries.createdAt,
        // Explicitly excluded: responseBody, payloadHash, leasedBy, leasedAt,
        // leaseExpiresAt, fencingToken
      })
      .from(tlsWebhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(tlsWebhookDeliveries.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const entries: TimelineEntry[] = page.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      responseCategory: toResponseCategory(row.lastStatusCode, row.status),
      attemptedAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
      nextRetryAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));

    const lastItem = page[page.length - 1];
    const nextCursor =
      hasMore && lastItem ? lastItem.createdAt.toISOString() : null;

    return Response.json({ data: entries, nextCursor });
  } catch (err) {
    logger.error({ subscriptionId: id, err }, "webhook_timeline_error");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);
