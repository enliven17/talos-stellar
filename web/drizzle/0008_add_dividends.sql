-- Add dividend distribution history table so Patrons can track the
-- history of revenue shared out to Mitos/Pulse token holders.
CREATE TABLE IF NOT EXISTS "tls_dividends" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "amount" numeric(18, 6) NOT NULL,
  "currency" text DEFAULT 'USDC' NOT NULL,
  "patronCount" integer DEFAULT 0 NOT NULL,
  "totalPulse" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'revenue-share' NOT NULL,
  "txHash" text,
  "breakdown" jsonb,
  "status" text DEFAULT 'completed' NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_dividends_talosId_createdAt_idx"
  ON "tls_dividends"("talosId", "createdAt");
--> statement-breakpoint
-- Row Level Security (consistent with all other tables in this schema)
ALTER TABLE "tls_dividends" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Dividend history is public read (Patrons & visitors can view distributions)
CREATE POLICY "anon_read_dividends" ON "tls_dividends"
  FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_dividends" ON "tls_dividends"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
-- The server (postgres role) performs all writes
CREATE POLICY "postgres_all_dividends" ON "tls_dividends"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
