-- Migration 0017: Create tls_api_keys table and add audit log fields (denialReason, scopesRequired)

CREATE TABLE IF NOT EXISTS "tls_api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "keyHash" text NOT NULL,
  "scopes" text[] DEFAULT '{}'::text[] NOT NULL,
  "expiresAt" timestamp(3),
  "lastUsedAt" timestamp(3),
  "status" text DEFAULT 'active' NOT NULL,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tls_api_keys_keyHash_unique" ON "tls_api_keys" ("keyHash");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_api_keys_talosId_status_idx" ON "tls_api_keys" ("talosId", "status");
--> statement-breakpoint

ALTER TABLE "tls_api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "postgres_all_api_keys" ON "tls_api_keys"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint

ALTER TABLE "tls_api_audit_logs" ADD COLUMN IF NOT EXISTS "denialReason" text;
--> statement-breakpoint

ALTER TABLE "tls_api_audit_logs" ADD COLUMN IF NOT EXISTS "scopesRequired" text[];
