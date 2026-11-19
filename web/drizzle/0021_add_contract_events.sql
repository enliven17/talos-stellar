CREATE TABLE IF NOT EXISTS "tls_contract_events" (
  "id" text PRIMARY KEY NOT NULL,
  "contract_id" text NOT NULL,
  "ledger" integer NOT NULL,
  "ledger_closed_at" timestamp(3),
  "tx_hash" text NOT NULL,
  "topic" text NOT NULL,
  "topics" jsonb,
  "data" jsonb,
  "decoded_payload" jsonb,
  "event_version" integer,
  "created_at" timestamp(3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_contract_events_id_unique" ON "tls_contract_events" ("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_contract_events_contract_id_idx" ON "tls_contract_events" ("contract_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_contract_events_ledger_idx" ON "tls_contract_events" ("ledger");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_contract_events_topic_idx" ON "tls_contract_events" ("topic");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_contract_events_tx_hash_idx" ON "tls_contract_events" ("tx_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tls_event_cursor" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "last_ledger" integer NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL
);
