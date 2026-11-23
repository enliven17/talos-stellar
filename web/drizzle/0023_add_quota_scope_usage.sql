-- Bounded observability breakdown for the existing per-agent quota totals.
-- tls_quota_usage remains the authoritative counter for enforcement.
CREATE TABLE IF NOT EXISTS "tls_quota_scope_usage" (
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "resource" text NOT NULL,
  "scope" text NOT NULL,
  "windowStart" timestamp(3) with time zone NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "updatedAt" timestamp(3) with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("talosId", "resource", "scope", "windowStart")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_quota_scope_usage_talosId_resource_idx"
  ON "tls_quota_scope_usage" ("talosId", "resource");
