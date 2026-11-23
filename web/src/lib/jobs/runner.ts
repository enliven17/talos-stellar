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
  maxLeaseExtensionMs?: number;
  maxLeaseHorizonMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Maximum jobs any single queue may contribute to one drain batch.
   * Default 0 (unlimited). When set, the batch is assembled by claiming at
   * most this many jobs per queue in priority/runAt order.
   */
  fairBatchPerQueue?: number;
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

  const batch = await store.leaseBatch(queues, opts.batchSize ?? jobsConfig.batchSize, opts.workerId, opts.leaseDurationMs, opts.fairBatchPerQueue);
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
  let currentLeaseExpiresAt: Date | null = job.leaseExpiresAt ? new Date(job.leaseExpiresAt) : null;
  const defaultLeaseDurationMs = opts.leaseDurationMs ?? jobsConfig.leaseDurationMs;
  const maxExtensionMs = opts.maxLeaseExtensionMs ?? jobsConfig.maxLeaseExtensionMs;
  const maxHorizonMs = opts.maxLeaseHorizonMs ?? jobsConfig.maxLeaseHorizonMs;

  const runHeartbeat = async (requestedDurationMs?: number) => {
    if (requestedDurationMs !== undefined) {
      if (
        !Number.isFinite(requestedDurationMs) ||
        requestedDurationMs <= 0 ||
        requestedDurationMs > maxExtensionMs ||
        requestedDurationMs > maxHorizonMs
      ) {
        // Contradictory extension request: reject without modifying or dropping the lease.
        return { ok: false, cancelled };
      }
      if (
        currentLeaseExpiresAt &&
        Number.isFinite(currentLeaseExpiresAt.getTime()) &&
        Date.now() + requestedDurationMs < currentLeaseExpiresAt.getTime()
      ) {
        // Reject request that would shorten the currently held lease expiry.
        return { ok: false, cancelled };
      }
    }

    const effectiveDurationMs = requestedDurationMs ?? defaultLeaseDurationMs;
    const candidateExpiryMs = Date.now() + effectiveDurationMs;
    const result = await store.heartbeat(job.id, leaseId, effectiveDurationMs);
    if (!result.ok) {
      lostLease = true;
    } else if (
      !currentLeaseExpiresAt ||
      !Number.isFinite(currentLeaseExpiresAt.getTime()) ||
      candidateExpiryMs > currentLeaseExpiresAt.getTime()
    ) {
      currentLeaseExpiresAt = new Date(candidateExpiryMs);
    }
    if (result.cancelled) cancelled = true;
    if (!result.ok || result.cancelled) controller.abort();
    return result;
  };

  const runExtendLease = async (extensionMs: number) => {
    const result = await store.extendLease(job.id, leaseId, extensionMs, {
      maxExtensionMs,
      maxHorizonMs,
    });
    if (result.ok && result.leaseExpiresAt) {
      currentLeaseExpiresAt = new Date(result.leaseExpiresAt);
    }
    if (result.cancelled) {
      cancelled = true;
      controller.abort();
    } else if (
      !result.ok &&
      (result.reason === "not_found" ||
        result.reason === "lease_mismatch" ||
        result.reason === "no_active_lease" ||
        result.reason === "lease_expired" ||
        result.reason === "invalid_job_state")
    ) {
      lostLease = true;
      controller.abort();
    }
    return result;
  };

  const heartbeatTimer = setInterval(() => {
    void runHeartbeat();
  }, opts.heartbeatIntervalMs ?? jobsConfig.heartbeatIntervalMs);
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
      extendLease: runExtendLease,
    });

    if (lostLease || cancelled) {
      if (cancelled) {
        summary.cancelled += 1;
        await store.recordAttempt({
          jobId: job.id,
          attemptNumber: job.attempts,
          workerId: opts.workerId ?? job.leaseOwner,
          leaseId,
          durationMs: Date.now() - startedAt,
          terminalReason: "cancelled",
        });
      }
      return;
    }

    const completed = await store.complete(job.id, leaseId, result, Date.now() - startedAt);
    if (completed === "conflict_cancelled") {
      // Cancellation raced with completion: the financial effect already ran,
      // so report the conflict instead of claiming cancellation succeeded.
      summary.completed += 1;
    } else if (completed) {
      summary.completed += 1;
    }
  } catch (err) {
    if (lostLease || cancelled) {
      if (cancelled) {
        summary.cancelled += 1;
        await store.recordAttempt({
          jobId: job.id,
          attemptNumber: job.attempts,
          workerId: opts.workerId ?? job.leaseOwner,
          leaseId,
          durationMs: Date.now() - startedAt,
          terminalReason: "cancelled",
          error: err,
        });
      }
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
