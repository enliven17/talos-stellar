import * as store from "./store";
import { getConsumers } from "./registry";
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
 * All consumers registered for an event's type run before it's ack'd; if
 * any throws, the whole event is retried (all consumers run again) or
 * dead-lettered per the retry policy — so consumers must be idempotent.
 * An event type with zero registered consumers dead-letters immediately
 * (nothing to retry against).
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
      const handlers = getConsumers(event.eventType);

      if (handlers.length === 0) {
        await store.fail(event.id, leaseId, new Error(`No consumer registered for event type "${event.eventType}"`));
        summary.deadLettered += 1;
        return;
      }

      try {
        for (const handler of handlers) await handler(event);
        const acked = await store.ack(event.id, leaseId);
        if (acked) summary.dispatched += 1;
      } catch (err) {
        const failed = await store.fail(event.id, leaseId, err);
        if (failed?.status === "dead_letter") summary.deadLettered += 1;
        else if (failed?.status === "pending") summary.retried += 1;
      }
    }),
  );

  return summary;
}
