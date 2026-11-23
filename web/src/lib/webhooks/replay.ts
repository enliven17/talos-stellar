import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { tlsOutboxEvents, tlsWebhookSubscriptions } from "@/db/schema";
import { writeOutboxEvent } from "@/lib/outbox/store";
import { logger } from "@/lib/logger";

export interface ReplayOptions {
  subscriptionId: string;
  startTime: Date;
  endTime: Date;
  replayId: string;
}

export interface ReplayResult {
  replayedCount: number;
}

export async function replayEvents(
  subscriptionId: string,
  startTime: Date,
  endTime: Date,
  replayId: string,
): Promise<ReplayResult> {
  if (startTime > endTime) {
    throw new Error("Invalid time window: startTime must be less than or equal to endTime");
  }

  // Get subscription to verify and get eventTypes
  const subscription = await db
    .select()
    .from(tlsWebhookSubscriptions)
    .where(eq(tlsWebhookSubscriptions.id, subscriptionId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!subscription) throw new Error("Subscription not found");

  // Query outbox events matching the types and time range
  const eventsToReplay = await db
    .select()
    .from(tlsOutboxEvents)
    .where(
      and(
        sql`${tlsOutboxEvents.eventType} = ANY(${subscription.eventTypes})`,
        gte(tlsOutboxEvents.createdAt, startTime),
        lte(tlsOutboxEvents.createdAt, endTime),
      ),
    );

  let replayedCount = 0;

  await db.transaction(async (tx) => {
    for (const event of eventsToReplay) {
      // Idempotency: use the replayId to ensure this event isn't replayed twice
      const dedupeKey = `replay:${replayId}:${event.id}`;

      // We re-write the event as a new pending event. The existing dispatcher will pick it up.
      // Explicitly tag payload as intentional redelivery
      await writeOutboxEvent(tx, {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: {
          ...(typeof event.payload === "object" && event.payload !== null ? event.payload : {}),
          isReplay: true,
          replayId,
          originalEventId: event.id,
        },
        dedupeKey,
      });
      replayedCount++;
    }
  });

  logger.info({ subscriptionId, replayId, replayedCount }, "webhook_replay_completed");
  return { replayedCount };
}
