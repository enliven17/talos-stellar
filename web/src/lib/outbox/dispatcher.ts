import * as store from "./store";
import { getConsumers } from "./registry";
import { validatePayload } from "./payload-schema";
import { outboxConfig } from "./config";
import { boundRetryDelayMs } from "./retry";
import type { DispatchSummary } from "./types";

const MAX_TRACKED_RETRY_COOLDOWNS = 10_000;

/**
 * In-process monotonic retry deadlines (`eventId -> monotonicMs`).
 * Guards against backward system-clock jumps causing a failed backlog to be
 * immediately re-dispatched before its bounded relative backoff has elapsed.
 */
const retryNotBeforeMonotonicMs = new Map<string, number>();

function defaultMonotonicNowMs(): number {
  return performance.now();
}

function pruneExpiredCooldowns(nowMonotonicMs: number): void {
  for (const [id, deadline] of retryNotBeforeMonotonicMs) {
    if (deadline <= nowMonotonicMs) retryNotBeforeMonotonicMs.delete(id);
  }
}

function recordRetryCooldown(eventId: string, nowMonotonicMs: number, delayMs: number): void {
  const bounded = boundRetryDelayMs(delayMs);
  if (bounded <= 0) {
    retryNotBeforeMonotonicMs.delete(eventId);
    return;
  }
  if (retryNotBeforeMonotonicMs.size >= MAX_TRACKED_RETRY_COOLDOWNS) {
    pruneExpiredCooldowns(nowMonotonicMs);
    if (retryNotBeforeMonotonicMs.size >= MAX_TRACKED_RETRY_COOLDOWNS) {
      const oldestKey = retryNotBeforeMonotonicMs.keys().next().value;
      if (oldestKey !== undefined) retryNotBeforeMonotonicMs.delete(oldestKey);
    }
  }
  retryNotBeforeMonotonicMs.set(eventId, nowMonotonicMs + bounded);
}

/** Test-only helper to clear in-process monotonic retry state between cases. */
export function __resetMonotonicRetryStateForTests(): void {
  retryNotBeforeMonotonicMs.clear();
}

export interface DispatchOnceOptions {
  batchSize?: number;
  workerId?: string;
  leaseDurationMs?: number;
  /** Optional monotonic clock source in milliseconds (defaults to `performance.now()`). */
  monotonicNowMs?: () => number;
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
 *
 * If a payload schema is declared for the event type (registerPayloadSchema)
 * and the payload violates it, the event is quarantined before any consumer
 * runs: a structurally invalid payload can never succeed, so it is not
 * retried and is excluded from leasing from then on.
 */
export async function dispatchOnce(opts: DispatchOnceOptions = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { leased: 0, dispatched: 0, retried: 0, deadLettered: 0, reaped: 0, pruned: 0 };
  const monotonicNow = opts.monotonicNowMs ?? defaultMonotonicNowMs;

  const reaped = await store.reapExpiredLeases();
  summary.reaped = reaped.requeued + reaped.deadLettered;
  summary.pruned = await store.pruneDispatched();

  const batch = await store.leaseBatch(opts.batchSize ?? outboxConfig.batchSize, opts.workerId, opts.leaseDurationMs);
  summary.leased = batch.length;

  const supportedVersions = opts.supportedPayloadVersions ?? outboxConfig.supportedPayloadVersions ?? DEFAULT_SUPPORTED_PAYLOAD_VERSIONS;

  await Promise.all(
    batch.map(async (event) => {
      const leaseId = event.leaseId!; // guaranteed by leaseBatch()
      const nowMonotonic = monotonicNow();
      const notBefore = retryNotBeforeMonotonicMs.get(event.id);
      if (notBefore !== undefined) {
        if (nowMonotonic < notBefore) {
          const remainingMs = boundRetryDelayMs(notBefore - nowMonotonic);
          if (typeof store.deferRetry === "function") {
            const deferred = await store.deferRetry(event.id, leaseId, remainingMs);
            if (deferred) summary.retried += 1;
          } else {
            summary.retried += 1;
          }
          return;
        }
        retryNotBeforeMonotonicMs.delete(event.id);
      }

      const handlers = getConsumers(event.eventType);

      if (handlers.length === 0) {
        await store.fail(event.id, leaseId, new Error(`No consumer registered for event type "${event.eventType}"`));
        retryNotBeforeMonotonicMs.delete(event.id);
        summary.deadLettered += 1;
        return;
      }

      try {
        for (const handler of handlers) await handler(event);
        const acked = await store.ack(event.id, leaseId);
        if (acked) {
          retryNotBeforeMonotonicMs.delete(event.id);
          summary.dispatched += 1;
        }
      } catch (err) {
        const failed = await store.fail(event.id, leaseId, err);
        if (failed?.status === "dead_letter") {
          retryNotBeforeMonotonicMs.delete(event.id);
          summary.deadLettered += 1;
        } else if (failed?.status === "pending") {
          const runAtMs = failed.runAt instanceof Date ? failed.runAt.getTime() : NaN;
          const updatedAtMs = failed.updatedAt instanceof Date ? failed.updatedAt.getTime() : NaN;
          const relativeDelayMs = Number.isFinite(runAtMs) && Number.isFinite(updatedAtMs)
            ? runAtMs - updatedAtMs
            : Number.isFinite(runAtMs)
              ? runAtMs - Date.now()
              : 0;
          recordRetryCooldown(event.id, monotonicNow(), relativeDelayMs);
          summary.retried += 1;
        }
      }
    }),
  );

  return summary;
}
