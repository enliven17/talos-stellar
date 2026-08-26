/**
 * Continuous outbox dispatcher.
 *
 * Alternative to the serverless drain route (/api/internal/outbox/drain)
 * for a long-lived deployment (e.g. Railway, the same way
 * packages/prime-agent runs as a standalone process).
 *
 * Usage: pnpm outbox:worker
 *
 * On SIGTERM/SIGINT: stops leasing new batches and waits for the in-flight
 * batch to finish (dispatch is expected to be fast — consumers are
 * in-process calls, not long-running jobs — so no separate lease-release
 * step is needed here the way the jobs worker needs one; anything still
 * running when the process exits simply hits its short lease expiry and
 * gets reaped by the next dispatcher).
 */
import "dotenv/config";
import { dispatchOnce, outboxConfig } from "../src/lib/outbox";
import { logger } from "../src/lib/logger";
import "../src/lib/outbox/consumers";

async function main(): Promise<void> {
  if (!outboxConfig.enabled) {
    logger.warn({ event: "outbox_worker_disabled" }, "OUTBOX_ENABLED is not true — worker is a no-op.");
  }
  logger.info({ event: "outbox_worker_started", workerId: outboxConfig.workerId }, "outbox worker started");

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "outbox_worker_shutting_down", signal }, "graceful shutdown initiated");
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!shuttingDown) {
    if (!outboxConfig.enabled) {
      await sleep(outboxConfig.pollIntervalMs);
      continue;
    }

    const summary = await dispatchOnce().catch((err) => {
      logger.error({ event: "outbox_worker_run_failed", err: String(err) }, "dispatchOnce() failed");
      return null;
    });

    if (shuttingDown) break;
    if (!summary || summary.leased === 0) await sleep(outboxConfig.pollIntervalMs);
  }

  logger.info({ event: "outbox_worker_stopped" }, "outbox worker stopped");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error({ event: "outbox_worker_fatal", err: String(err) }, "outbox worker crashed");
  process.exit(1);
});
