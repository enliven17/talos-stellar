-- Outbox payload-schema quarantine.
--
-- Additive only: two nullable columns, no backfill, no existing-row changes.
-- "schemaVersion"      — declared payload schema version the event was validated against.
-- "validationSummary"  — bounded validation summary (≤10 issues, paths/codes/messages only,
--                        never payload values) persisted when an event is quarantined.
-- Quarantined rows use status = 'quarantined' and are never leased again.

ALTER TABLE "tls_outbox_events" ADD COLUMN IF NOT EXISTS "schemaVersion" integer;
--> statement-breakpoint
ALTER TABLE "tls_outbox_events" ADD COLUMN IF NOT EXISTS "validationSummary" jsonb;
