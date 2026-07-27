-- Idempotency table for token-purchase side effects.
--
-- txHash (the Stellar payment transaction hash supplied by the buyer) is the
-- stable idempotency key: it is cryptographically unique, client-provided
-- before the request, and the natural identity for a single purchase event.
--
-- Status lifecycle:
--   pending   → row inserted at request start; concurrent duplicates hit the
--               unique constraint and receive a 409 "in-progress" response.
--   completed → side effects (patron upsert + revenue insert) committed;
--               the original response body is cached for replay-safe retries.
--   failed    → side effects rolled back; the row is kept for audit.
--
-- The server's db.transaction() atomically performs patron upsert,
-- revenue insert, and the pending→completed flip, so a crash before
-- commit leaves the row in "pending" and no duplicate rows are written.

CREATE TABLE IF NOT EXISTS "tls_token_purchases" (
  "txHash"          text PRIMARY KEY NOT NULL,
  "talosId"         text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "buyerPublicKey"  text NOT NULL,
  "amount"          integer NOT NULL,
  "totalCost"       numeric(18, 6) NOT NULL,
  "status"          text DEFAULT 'pending' NOT NULL,
  "responseBody"    jsonb,
  "createdAt"       timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt"       timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_token_purchases_talosId_createdAt_idx"
  ON "tls_token_purchases"("talosId", "createdAt");
--> statement-breakpoint
-- Row Level Security (consistent with all other tables)
ALTER TABLE "tls_token_purchases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Purchase history is public read — Patrons & visitors can view the log
CREATE POLICY "anon_read_token_purchases" ON "tls_token_purchases"
  FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_token_purchases" ON "tls_token_purchases"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
-- The server (postgres role) performs all writes
CREATE POLICY "postgres_all_token_purchases" ON "tls_token_purchases"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
