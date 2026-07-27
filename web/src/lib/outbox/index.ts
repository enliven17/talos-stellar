/**
 * Transactional outbox for domain events (web boundary).
 *
 * writeOutboxEvent(tx, ...) inside an existing db.transaction() atomically
 * records an event alongside the mutation it describes. dispatchOnce()
 * leases due events (SELECT ... FOR UPDATE SKIP LOCKED, safe across
 * multiple instances) and runs registered consumers, retrying with backoff
 * or dead-lettering on exhaustion.
 *
 * See web/OUTBOX.md for configuration, operational signals, and rollback.
 */
export { writeOutboxEvent, getEvent, listEvents, requeue } from "./store";
export { registerConsumer } from "./registry";
export { dispatchOnce } from "./dispatcher";
export { outboxConfig, OUTBOX_ENABLED } from "./config";
export type { Consumer, DispatchSummary, OutboxEvent, OutboxStatus, WriteEventInput } from "./types";
