import { logger } from "@/lib/logger";
import { registerConsumer } from "../registry";

/**
 * Minimal consumer proving the write → dispatch pipeline end to end.
 * Logs only identifiers, never the payload (see metrics.ts's rationale —
 * a consumer here stands in for a real integration, e.g. publishing to an
 * external event bus, and shouldn't set a precedent of logging payloads).
 */
registerConsumer("commerce_job.completed", async (event) => {
  logger.info({ event: "outbox_consumer_log", eventId: event.id, aggregateId: event.aggregateId }, "commerce_job.completed observed");
});
