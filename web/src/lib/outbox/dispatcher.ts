import * as store from "./store";
import { getConsumers } from "./registry";
import { DEFAULT_OUTBOX_PAYLOAD_VERSION, DEFAULT_SUPPORTED_PAYLOAD_VERSIONS, outboxConfig } from "./config";
import type { DispatchSummary, OutboxEvent } from "./types";

export class UnsupportedPayloadVersionError extends Error {
  readonly version: unknown;
  readonly supportedVersions: number[];

  constructor(version: unknown, supportedVersions: number[] = DEFAULT_SUPPORTED_PAYLOAD_VERSIONS) {
    const supportedList = Array.isArray(supportedVersions) ? supportedVersions : DEFAULT_SUPPORTED_PAYLOAD_VERSIONS;
    super(
      `Unsupported outbox event payload version: ${String(version)}. Supported versions: [${supportedList.join(", ")}]`,
    );
    this.name = "UnsupportedPayloadVersionError";
    this.version = version;
    this.supportedVersions = supportedList;
  }
}

/**
 * Extracts and validates the payload version from an outbox event.
 * If the payload is unversioned (no version field), it defaults to DEFAULT_OUTBOX_PAYLOAD_VERSION (1).
 * If the version is not among the supported versions, throws UnsupportedPayloadVersionError.
 */
export function extractAndValidatePayloadVersion(
  event: OutboxEvent,
  supportedVersions: number[] = outboxConfig.supportedPayloadVersions ?? DEFAULT_SUPPORTED_PAYLOAD_VERSIONS,
): number {
  const allowed = Array.isArray(supportedVersions) && supportedVersions.length > 0
    ? supportedVersions
    : DEFAULT_SUPPORTED_PAYLOAD_VERSIONS;

  const payload = event.payload;
  let version: unknown = DEFAULT_OUTBOX_PAYLOAD_VERSION;

  if (payload && typeof payload === "object" && !Array.isArray(payload) && "version" in payload) {
    version = (payload as Record<string, unknown>).version;
  }

  if (typeof version !== "number" || !Number.isInteger(version) || !allowed.includes(version)) {
    throw new UnsupportedPayloadVersionError(version, allowed);
  }

  return version;
}

export interface DispatchOnceOptions {
  batchSize?: number;
  workerId?: string;
  leaseDurationMs?: number;
  supportedPayloadVersions?: number[];
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

  const supportedVersions = opts.supportedPayloadVersions ?? outboxConfig.supportedPayloadVersions ?? DEFAULT_SUPPORTED_PAYLOAD_VERSIONS;

  await Promise.all(
    batch.map(async (event) => {
      const leaseId = event.leaseId!; // guaranteed by leaseBatch()

      try {
        extractAndValidatePayloadVersion(event, supportedVersions);
      } catch (err) {
        await store.fail(event.id, leaseId, err, { fatal: true });
        summary.deadLettered += 1;
        return;
      }

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
