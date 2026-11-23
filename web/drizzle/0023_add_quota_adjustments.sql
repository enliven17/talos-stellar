-- Append-only audit trail for quota policy adjustments.
-- Stores actor, reason, prior policy and new policy. Credentials are redacted
-- by the application before insert and must never be stored here.

CREATE TABLE IF NOT EXISTS "tls_quota_adjustments" (
  "id"          text PRIMARY KEY,
  "talosId"     text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "resource"    text NOT NULL,
  "actor"       text NOT NULL,
  "reason"      text NOT NULL,
  "priorPolicy" jsonb NOT NULL,
  "newPolicy"   jsonb NOT NULL,
  "createdAt"   timestamp(3) with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_quota_adjustments_talosId_createdAt_idx"
  ON "tls_quota_adjustments" ("talosId", "createdAt");
