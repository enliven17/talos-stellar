-- Durable background-job execution framework (web boundary).
--
-- Postgres-backed queue: workers claim rows with
-- `SELECT ... FOR UPDATE SKIP LOCKED` so multiple app instances can drain
-- the same queue safely without a broker. See src/lib/jobs/store.ts.
--
-- Status lifecycle:
--   pending → leased → completed
--                    ↘ pending (transient failure, runAt pushed out)
--                    ↘ dead_letter (retries exhausted / fatal error)
--   pending|leased → cancelled

CREATE TABLE IF NOT EXISTS "tls_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "queue" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "runAt" timestamp(3) DEFAULT now() NOT NULL,
  "leaseId" text,
  "leaseOwner" text,
  "leaseExpiresAt" timestamp(3),
  "heartbeatAt" timestamp(3),
  "attempts" integer DEFAULT 0 NOT NULL,
  "maxAttempts" integer DEFAULT 8 NOT NULL,
  "retryClass" text DEFAULT 'transient' NOT NULL,
  "cancelRequested" boolean DEFAULT false NOT NULL,
  "idempotencyKey" text,
  "lastError" text,
  "result" jsonb,
  "createdAt" timestamp(3) DEFAULT now() NOT NULL,
  "updatedAt" timestamp(3) NOT NULL,
  "completedAt" timestamp(3)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_jobs_status_runAt_idx" ON "tls_jobs" ("status", "runAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_jobs_queue_status_idx" ON "tls_jobs" ("queue", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_jobs_leaseExpiresAt_idx" ON "tls_jobs" ("leaseExpiresAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_jobs_queue_idempotencyKey_unique"
  ON "tls_jobs" ("queue", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
