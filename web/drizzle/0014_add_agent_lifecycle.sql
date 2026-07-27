-- Governed agent lifecycle: canonical event log + durable provisioning jobs.
--
-- Both tables are additive. No existing column or constraint changes, so this
-- migration is safe to apply ahead of the application deploy, and rolling back
-- the application does not require rolling back the schema.
--
-- Rollback (only if the tables must be removed):
--   DROP TABLE IF EXISTS "tls_provisioning_jobs";
--   DROP TABLE IF EXISTS "tls_lifecycle_events";
-- Dropping discards the transition history; prefer leaving the tables in place.

CREATE TABLE IF NOT EXISTS "tls_lifecycle_events" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "eventType" text NOT NULL,
  "fromState" text,
  "toState" text NOT NULL,
  "actorId" text NOT NULL,
  "actorRole" text NOT NULL,
  "jobId" text,
  "stepName" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotencyKey" text,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint

-- Monotonic replay cursor. The unique constraint is what makes concurrent
-- appenders safe: two workers racing to write sequence N both attempt the
-- insert and exactly one wins; the loser re-reads the tip and retries.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_lifecycle_events_talosId_sequence_key"
  ON "tls_lifecycle_events" ("talosId", "sequence");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_lifecycle_events_talosId_createdAt_idx"
  ON "tls_lifecycle_events" ("talosId", "createdAt");
--> statement-breakpoint

-- Duplicate delivery from an at-least-once producer collapses onto one row.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_lifecycle_events_talosId_idempotencyKey_unique"
  ON "tls_lifecycle_events" ("talosId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tls_provisioning_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cursor" integer DEFAULT 0 NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "maxAttempts" integer DEFAULT 3 NOT NULL,
  "lastError" text,
  "leasedBy" text,
  "leaseExpiresAt" timestamp(3),
  "fencingToken" integer DEFAULT 0 NOT NULL,
  "requestedBy" text NOT NULL,
  "idempotencyKey" text NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "completedAt" timestamp(3)
);
--> statement-breakpoint

-- A resubmitted lifecycle action returns the original run instead of starting
-- a second one. Scoped per agent so keys need only be unique per agent.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_provisioning_jobs_talosId_idempotencyKey_unique"
  ON "tls_provisioning_jobs" ("talosId", "idempotencyKey");
--> statement-breakpoint

-- Worker scan: find claimable runs (pending, or leased past expiry).
CREATE INDEX IF NOT EXISTS "tls_provisioning_jobs_status_idx"
  ON "tls_provisioning_jobs" ("status", "leaseExpiresAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_provisioning_jobs_talosId_createdAt_idx"
  ON "tls_provisioning_jobs" ("talosId", "createdAt");
--> statement-breakpoint

ALTER TABLE "tls_lifecycle_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_provisioning_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The server (postgres role) owns writes. Lifecycle history is public-readable
-- because it is the governance audit trail; the detail column is redacted at
-- write time so nothing sensitive is exposed by that read.
CREATE POLICY "postgres_all_lifecycle_events" ON "tls_lifecycle_events"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "anon_read_lifecycle_events" ON "tls_lifecycle_events"
  FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_lifecycle_events" ON "tls_lifecycle_events"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint

-- Provisioning runs carry operator-only diagnostics: server + authenticated
-- reads only, never anon.
CREATE POLICY "postgres_all_provisioning_jobs" ON "tls_provisioning_jobs"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_read_provisioning_jobs" ON "tls_provisioning_jobs"
  FOR SELECT TO authenticated USING (true);
