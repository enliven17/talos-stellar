-- Stellar Transaction Finality Records
-- ──────────────────────────────────────────────────────────────────────────
-- Tracks the settlement lifecycle of every Stellar transaction that Talos
-- submits or monitors.  The reconciler polls Horizon and drives each row
-- through the finality state machine until it reaches a terminal state.
--
-- State machine
-- ─────────────
--   PENDING      → Transaction has been submitted but not yet seen on Horizon.
--   CONFIRMING   → Horizon returned the transaction; waiting for sufficient
--                  ledger depth (reorg safety window).
--   CONFIRMED    → Transaction is settled and irreversible.  Repair applied.
--   FAILED       → Transaction was seen but marked unsuccessful on-chain.
--   EXPIRED      → Transaction was never seen within the max_ledger_gap window.
--   NOT_FOUND    → Repeated polls returned 404 past the NOT_FOUND threshold.
--
-- Columns
-- ───────
--   tx_hash          — Stellar transaction hash (unique lookup key)
--   source_type      — Which subsystem submitted the tx: "commerce_job" | "token_purchase" | "other"
--   source_id        — FK equivalent: job id, txHash of token purchase, etc.
--   finality_status  — Current state-machine position (see above)
--   ledger_submitted — Ledger sequence number when tx was submitted (if known)
--   last_ledger_checked — Most recent ledger polled; bounds the re-scan window
--   confirmed_ledger — Ledger in which the tx was permanently included
--   poll_count       — How many poll attempts have been made
--   last_error       — Last error message from Horizon (non-secret; for ops dashboards)
--   repair_applied   — Whether the reconciler has performed the downstream repair
--   expires_at       — After this timestamp PENDING/CONFIRMING transitions to EXPIRED
--   created_at       — When this record was inserted
--   updated_at       — Last state transition timestamp

CREATE TABLE IF NOT EXISTS "tls_stellar_tx_records" (
  "id"                  text PRIMARY KEY NOT NULL,
  "tx_hash"             text NOT NULL,
  "source_type"         text NOT NULL DEFAULT 'other',
  "source_id"           text,
  "finality_status"     text NOT NULL DEFAULT 'PENDING',
  "ledger_submitted"    integer,
  "last_ledger_checked" integer,
  "confirmed_ledger"    integer,
  "poll_count"          integer NOT NULL DEFAULT 0,
  "last_error"          text,
  "repair_applied"      boolean NOT NULL DEFAULT false,
  "expires_at"          timestamp(3),
  "created_at"          timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at"          timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint

-- Unique constraint: one finality record per tx hash
-- (same tx cannot be tracked twice under the same hash)
CREATE UNIQUE INDEX IF NOT EXISTS "tls_stellar_tx_records_tx_hash_unique"
  ON "tls_stellar_tx_records" ("tx_hash");
--> statement-breakpoint

-- Index for reconciler batch query: non-terminal rows ordered by poll priority
CREATE INDEX IF NOT EXISTS "tls_stellar_tx_records_status_updated_idx"
  ON "tls_stellar_tx_records" ("finality_status", "updated_at")
  WHERE "finality_status" IN ('PENDING', 'CONFIRMING');
--> statement-breakpoint

-- Index for source-based lookups (e.g. "find record for commerce job X")
CREATE INDEX IF NOT EXISTS "tls_stellar_tx_records_source_idx"
  ON "tls_stellar_tx_records" ("source_type", "source_id")
  WHERE "source_id" IS NOT NULL;
--> statement-breakpoint

-- Row Level Security (consistent with all other tls_ tables)
ALTER TABLE "tls_stellar_tx_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Operators and dashboards may read all records
CREATE POLICY "anon_read_stellar_tx_records" ON "tls_stellar_tx_records"
  FOR SELECT TO anon USING (true);
--> statement-breakpoint

CREATE POLICY "auth_read_stellar_tx_records" ON "tls_stellar_tx_records"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint

-- The server (postgres role) performs all writes
CREATE POLICY "postgres_all_stellar_tx_records" ON "tls_stellar_tx_records"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
