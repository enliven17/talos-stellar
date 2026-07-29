/**
 * Continuous background-job worker.
 *
 * Next.js on Vercel has no persistent process, so the API route at
 * /api/internal/jobs/drain (triggered by an external scheduler) is the
 * serverless path for draining the queue. This script is the alternative
 * for a long-lived deployment — e.g. a Railway service, the same way
 * packages/prime-agent already runs as a standalone process — and is the
 * concrete implementation of the framework's graceful-shutdown requirement.
 *
 * Usage:
 *   pnpm jobs:worker
 *
 * On SIGTERM/SIGINT: stops leasing new batches, waits up to
 * JOBS_SHUTDOWN_GRACE_MS for the in-flight batch to finish, then exits.
 * Jobs still running past the grace period have their leases released back
 * to pending immediately (rather than waiting out the full lease timeout)
 * so another worker can pick them up right away.
 */
import "dotenv/config";
import { jobsConfig, release, runOnce } from "../src/lib/jobs";
import type { JobRecord, RunOnceSummary } from "../src/lib/jobs";
import { logger } from "../src/lib/logger";
// Side-effect import: registers every job handler.
import "../src/lib/jobs/handlers";

async function main(): Promise<void> {
  if (!jobsConfig.enabled) {
    logger.warn({ event: "jobs_worker_disabled" }, "JOBS_ENABLED is not true — worker is a no-op. Set JOBS_ENABLED=true to process jobs.");
  }

  logger.info({ event: "jobs_worker_started", workerId: jobsConfig.workerId }, "jobs worker started");

  let shuttingDown = false;
  const controller = new AbortController();
  let currentRun: Promise<RunOnceSummary | null> | null = null;
  // The most recently leased batch. release() is a no-op for any job that
  // has already reached a terminal status by the time it's called, so it's
  // safe to release every job in this list unconditionally on a hard exit —
  // whichever ones already completed/failed simply match zero rows.
  let inFlight: JobRecord[] = [];

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "jobs_worker_shutting_down", signal }, "graceful shutdown initiated");
    controller.abort();

    const timer = setTimeout(() => {
      logger.warn(
        { event: "jobs_worker_shutdown_grace_exceeded", inFlight: inFlight.length },
        "shutdown grace period exceeded — releasing in-flight leases and exiting",
      );
      Promise.all(inFlight.map((job) => release(job.id, job.leaseId!).catch(() => null)))
        .finally(() => process.exit(0))
        .catch(() => process.exit(0));
    }, jobsConfig.shutdownGraceMs);
    timer.unref();

    Promise.resolve(currentRun)
      .finally(() => {
        clearTimeout(timer);
        logger.info({ event: "jobs_worker_stopped" }, "jobs worker stopped");
        process.exit(0);
      })
      .catch(() => {});
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!shuttingDown) {
    if (!jobsConfig.enabled) {
      await sleep(jobsConfig.pollIntervalMs, controller.signal);
      continue;
    }

    currentRun = runOnce({
      signal: controller.signal,
      onLeased: (batch) => {
        inFlight = batch;
      },
    }).catch((err) => {
      logger.error({ event: "jobs_worker_run_failed", err: String(err) }, "runOnce() failed");
      return null;
    });
    const summary = await currentRun;
    currentRun = null;
    inFlight = [];

    if (shuttingDown) break;

    if (!summary || summary.leased === 0) {
      await sleep(jobsConfig.pollIntervalMs, controller.signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

main().catch((err) => {
  logger.error({ event: "jobs_worker_fatal", err: String(err) }, "jobs worker crashed");
  process.exit(1);
});
