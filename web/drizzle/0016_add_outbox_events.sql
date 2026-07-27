-- Transactional outbox for domain events (web boundary).
--
-- Written atomically inside the same db.transaction as the domain mutation
-- it describes. Dispatched via SELECT ... FOR UPDATE SKIP LOCKED leasing
-- (src/lib/outbox/store.ts), safe across multiple app instances.

CREATE TABLE IF NOT EXISTS "tls_outbox_events" (
  "id" text PRIMARY KEY NOT NULL,
  "aggregateType" text NOT NULL,
  "aggregateId" text NOT NULL,
  "eventType" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "runAt" timestamp(3) DEFAULT now() NOT NULL,
  "leaseId" text,
  "leaseOwner" text,
  "leaseExpiresAt" timestamp(3),
  "attempts" integer DEFAULT 0 NOT NULL,
  "maxAttempts" integer DEFAULT 8 NOT NULL,
  "dedupeKey" text,
  "lastError" text,
  "createdAt" timestamp(3) DEFAULT now() NOT NULL,
  "updatedAt" timestamp(3) NOT NULL,
  "dispatchedAt" timestamp(3)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_outbox_events_status_runAt_idx" ON "tls_outbox_events" ("status", "runAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_outbox_events_eventType_status_idx" ON "tls_outbox_events" ("eventType", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_outbox_events_leaseExpiresAt_idx" ON "tls_outbox_events" ("leaseExpiresAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_outbox_events_dispatchedAt_idx" ON "tls_outbox_events" ("dispatchedAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_outbox_events_eventType_dedupeKey_unique"
  ON "tls_outbox_events" ("eventType", "dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;
