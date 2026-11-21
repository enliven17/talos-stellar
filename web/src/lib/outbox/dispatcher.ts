import * as store from "./store";
import { getRegisteredConsumers } from "./registry";
import { outboxConfig } from "./config";
import type { DispatchSummary } from "./types";

export interface DispatchOnceOptions {
  batchSize?: number;
  workerId?: string;
  leaseDurationMs?: number;
}

/**
 * Leases and dispatches one bounded batch of due events, then returns.
 * Mirrors the jobs-queue drain shape: bounded so a single call fits inside
 * a serverless function's execution budget (see /api/internal/outbox/drain
 * and scripts/outbox-worker.ts).
 *
 * Delivery state is tracked independently per registered consumer:
 * - Each consumer that succeeds is persisted as `acked` and skipped on
 *   subsequent retries if another consumer fails.
 * - A failing consumer records its own retry backoff (`nextRetryAt`) or
 *   transitions to `dead_letter` when its retry budget is exhausted.
 * - The event itself is marked `dispatched` only once all registered
 *   consumers are `acked`, rescheduled to the earliest pending consumer's
 *   `nextRetryAt` while retries remain, or marked `dead_letter` once no
 *   pending consumers remain and at least one consumer dead-lettered.
 * - An event type with zero registered consumers dead-letters immediately.
 */
export async function dispatchOnce(opts: DispatchOnceOptions = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { leased: 0, dispatched: 0, retried: 0, deadLettered: 0, reaped: 0, pruned: 0 };

  const reaped = await store.reapExpiredLeases();
  summary.reaped = reaped.requeued + reaped.deadLettered;
  summary.pruned = await store.pruneDispatched();

  const batch = await store.leaseBatch(opts.batchSize ?? outboxConfig.batchSize, opts.workerId, opts.leaseDurationMs);
  summary.leased = batch.length;

  await Promise.all(
    batch.map(async (event) => {
      const leaseId = event.leaseId!; // guaranteed by leaseBatch()
      const consumers = getRegisteredConsumers(event.eventType);

      if (consumers.length === 0) {
        await store.fail(event.id, leaseId, new Error(`No consumer registered for event type "${event.eventType}"`));
        summary.deadLettered += 1;
        return;
      }

      const deliveries = await store.getConsumerDeliveries(event.id);
      const deliveryByConsumer = new Map(deliveries.map((d) => [d.consumerId, d]));

      const now = Date.now();
      let earliestRetryAt: Date | null = null;
      let hasDeadLetter = false;
      let lastError: unknown = null;
      let leaseLost = false;

      const trackRetryAt = (candidate: Date) => {
        if (earliestRetryAt === null || candidate.getTime() < earliestRetryAt.getTime()) {
          earliestRetryAt = candidate;
        }
      };

      for (const { id: consumerId, handler } of consumers) {
        const existing = deliveryByConsumer.get(consumerId);

        if (existing?.status === "acked") {
          continue;
        }

        if (existing?.status === "dead_letter") {
          hasDeadLetter = true;
          if (lastError === null && existing.lastError) lastError = existing.lastError;
          continue;
        }

        if (existing?.status === "pending" && existing.nextRetryAt.getTime() > now) {
          trackRetryAt(existing.nextRetryAt);
          if (lastError === null && existing.lastError) lastError = existing.lastError;
          continue;
        }

        try {
          await handler(event);
          const ackedDelivery = await store.ackConsumer(event.id, consumerId, leaseId);
          if (!ackedDelivery) {
            leaseLost = true;
            break;
          }
        } catch (err) {
          const failedDelivery = await store.failConsumer(event.id, consumerId, leaseId, err);
          if (!failedDelivery) {
            leaseLost = true;
            break;
          }
          lastError = err;
          if (failedDelivery.status === "dead_letter") {
            hasDeadLetter = true;
          } else {
            trackRetryAt(failedDelivery.nextRetryAt);
          }
        }
      }

      if (leaseLost) return;

      if (earliestRetryAt !== null) {
        const rescheduled = await store.rescheduleForRetry(
          event.id,
          leaseId,
          earliestRetryAt,
          lastError ?? "consumer delivery failed",
        );
        if (rescheduled) summary.retried += 1;
      } else if (hasDeadLetter) {
        const deadLettered = await store.deadLetter(event.id, leaseId, lastError ?? "consumer retries exhausted");
        if (deadLettered) summary.deadLettered += 1;
      } else {
        const acked = await store.ack(event.id, leaseId);
        if (acked) summary.dispatched += 1;
      }
    }),
  );

  return summary;
}
