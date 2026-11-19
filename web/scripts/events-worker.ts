/**
 * Continuous contract events poller / indexer worker.
 *
 * Polls Soroban RPC getEvents starting from the persisted cursor ledger
 * and stores decoded contract events into tls_contract_events.
 *
 * Usage: pnpm events:worker
 * Pattern mirrors: web/scripts/outbox-worker.ts
 */
import "dotenv/config";
import { pollContractEventsOnce, defaultIndexerConfig } from "../src/lib/contract-events";
import { logger } from "../src/lib/logger";

async function main(): Promise<void> {
  const enabled = process.env.CONTRACT_EVENTS_INDEXER_ENABLED !== "false";
  if (!enabled) {
    logger.warn({ event: "events_worker_disabled" }, "CONTRACT_EVENTS_INDEXER_ENABLED is false — worker is a no-op.");
  }
  logger.info(
    {
      event: "events_worker_started",
      pollIntervalMs: defaultIndexerConfig.pollIntervalMs,
      batchLimit: defaultIndexerConfig.batchLimit,
    },
    "contract events worker started",
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "events_worker_shutting_down", signal }, "graceful shutdown initiated");
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  while (!shuttingDown) {
    if (!enabled) {
      await sleep(defaultIndexerConfig.pollIntervalMs);
      continue;
    }

    const summary = await pollContractEventsOnce(defaultIndexerConfig).catch((err) => {
      logger.error({ event: "events_worker_poll_failed", err: String(err) }, "pollContractEventsOnce() failed");
      return null;
    });

    if (shuttingDown) break;

    // Sleep before next polling pass
    await sleep(defaultIndexerConfig.pollIntervalMs);
  }

  logger.info({ event: "events_worker_stopped" }, "contract events worker stopped");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  logger.error({ event: "events_worker_fatal", err: String(err) }, "contract events worker crashed");
  process.exit(1);
});
