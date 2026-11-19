import * as store from "./store";
import { getHandler, registeredQueues } from "./registry";
import { jobsConfig } from "./config";
import type { JobRecord, RunOnceSummary } from "./types";

export interface RunOnceOptions {
  /** Which queues to drain. Defaults to every registered handler's queue. */
  queues?: string[];
  batchSize?: number;
  workerId?: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** Aborts in-flight handlers (e.g. from graceful shutdown). */
  signal?: AbortSignal;
  /**
   * Called with the claimed batch right after leasing, before any handler
   * runs. Lets a long-lived caller (scripts/jobs-worker.ts) track which
   * (id, leaseId) pairs are currently in flight so it can release them back
   * to pending immediately if it has to exit before they finish — see
   * `release()` in store.ts.
   */
  onLeased?: (jobs: JobRecord[]) => void;
}

/**
 * Leases and processes one bounded batch of due jobs, then returns. This is
 * the unit both the serverless drain endpoint (/api/internal/jobs/drain,
 * triggered by an external scheduler) and the continuous worker loop
 * (scripts/jobs-worker.ts) build on — the batch is intentionally bounded so
 * a single call fits inside a serverless function's execution budget.
 */
export async function runOnce(opts: RunOnceOptions = {}): Promise<RunOnceSummary> {
  const queues = opts.queues ?? registeredQueues();
  const summary: RunOnceSummary = {
    leased: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    cancelled: 0,
    reaped: 0,
  };

  // Recover jobs whose worker died mid-lease before claiming new work, so a
  // crash never strands a job past its lease window longer than necessary.
  const reaped = await store.reapExpiredLeases();
  summary.reaped = reaped.requeued + reaped.deadLettered;

  if (queues.length === 0) return summary;

  const batch = await store.leaseBatch(queues, opts.batchSize ?? jobsConfig.batchSize, opts.workerId, opts.leaseDurationMs);
  summary.leased = batch.length;
  opts.onLeased?.(batch);

  await Promise.all(batch.map((job) => processJob(job, opts, summary)));

  return summary;
}

async function processJob(job: JobRecord, opts: RunOnceOptions, summary: RunOnceSummary): Promise<void> {
  const leaseId = job.leaseId!; // guaranteed by leaseBatch()
  const handler = getHandler(job.queue);

  if (!handler) {
    // Stale row for a queue nothing handles anymore (e.g. a removed
    // feature) — dead-letter instead of retrying forever against nothing.
    await store.fail(job.id, leaseId, new Error(`No handler registered for queue "${job.queue}"`));
    summary.deadLettered += 1;
    return;
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onExternalAbort);

  let lostLease = false;
  let cancelled = false;
  const runHeartbeat = async () => {
    const result = await store.heartbeat(job.id, leaseId, opts.leaseDurationMs);
    if (!result.ok) lostLease = true;
    if (result.cancelled) cancelled = true;
    if (!result.ok || result.cancelled) controller.abort();
    return result;
  };

  const heartbeatTimer = setInterval(runHeartbeat, opts.heartbeatIntervalMs ?? jobsConfig.heartbeatIntervalMs);
  // Node timers keep the event loop alive; workers must be able to shut down
  // even if a heartbeat is pending.
  heartbeatTimer.unref?.();

  const startedAt = Date.now();
  try {
    const result = await handler({
      id: job.id,
      queue: job.queue,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      payload: job.payload,
      signal: controller.signal,
      heartbeat: runHeartbeat,
    });

    if (lostLease || cancelled) {
      if (cancelled) summary.cancelled += 1;
      return;
    }

    const completed = await store.complete(job.id, leaseId, result, Date.now() - startedAt);
    if (completed) summary.completed += 1;
  } catch (err) {
    if (lostLease || cancelled) {
      if (cancelled) summary.cancelled += 1;
      return;
    }

    const failed = await store.fail(job.id, leaseId, err, Date.now() - startedAt);
    if (failed?.status === "dead_letter") summary.deadLettered += 1;
    else if (failed?.status === "pending") summary.retried += 1;
  } finally {
    clearInterval(heartbeatTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}
