-- Consumed nonces table for persistent replay protection of signed transfers.
--
-- Every consumed transfer nonce is recorded in this table with a UNIQUE
-- constraint on (talosId, nonce) so the database enforces single-use
-- semantics across process restarts and concurrent requests.
--
-- Vacuum strategy (safe to run periodically, e.g. via pg_cron or a
-- background request):
--   DELETE FROM "tls_consumed_nonces"
--   WHERE "expiry" < EXTRACT(EPOCH FROM NOW()) - 3600;
-- This removes rows whose original auth window has been closed for at
-- least one hour, well past the 5-minute max auth lifetime.
--
-- Rollback:
--   DROP TABLE IF EXISTS "tls_consumed_nonces";
-- Dropping discards the replay history; replays of old nonces become
-- possible after rollback.

CREATE TABLE IF NOT EXISTS "tls_consumed_nonces" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL,
  "nonce" text NOT NULL,
  "expiry" integer NOT NULL,
  "consumedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint

-- Unique constraint enforces single-use per nonce per agent.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_consumed_nonces_talosId_nonce_key"
  ON "tls_consumed_nonces" ("talosId", "nonce");
--> statement-breakpoint

-- Index for the vacuum: prune rows whose expiry has passed + 1h buffer.
CREATE INDEX IF NOT EXISTS "tls_consumed_nonces_expiry_idx"
  ON "tls_consumed_nonces" ("expiry");
--> statement-breakpoint

ALTER TABLE "tls_consumed_nonces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The server owns writes. Nonces are not sensitive — consume records are
-- internal replay guards — so postgres role covers all operations.
CREATE POLICY "postgres_all_consumed_nonces" ON "tls_consumed_nonces"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
