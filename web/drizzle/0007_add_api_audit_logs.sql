-- Add API key audit log table for security hardening
CREATE TABLE IF NOT EXISTS "tls_api_audit_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "statusCode" integer NOT NULL,
  "ipAddress" text,
  "createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_api_audit_logs_talosId_createdAt_idx"
  ON "tls_api_audit_logs"("talosId", "createdAt");
--> statement-breakpoint
ALTER TABLE "tls_api_audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Only the server (postgres role) and authenticated users can read their own logs
CREATE POLICY "postgres_all_api_audit_logs" ON "tls_api_audit_logs"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_read_api_audit_logs" ON "tls_api_audit_logs"
  FOR SELECT TO authenticated USING (true);
