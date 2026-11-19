-- Add retirement tracking and soft deletion fields to tls_talos
-- This preserves historical identity while preventing ID/name reuse

ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "retiredAt" timestamp(3);
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "retiredReason" text;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "supersededBy" text;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "deletedAt" timestamp(3);
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "deletedReason" text;

-- Add partial unique index to prevent agentName reuse among active agents
-- This allows retired agents to keep their names while preventing new agents from using them
CREATE UNIQUE INDEX IF NOT EXISTS "tls_talos_agentName_active_key" ON "tls_talos" ("agentName") WHERE "retiredAt" IS NULL;

-- Change foreign key constraints from CASCADE to RESTRICT to preserve historical data
-- This prevents accidental deletion of commerce history when agents are retired

-- Drop existing foreign key constraints
ALTER TABLE "tls_patrons" DROP CONSTRAINT IF EXISTS "tls_patrons_talosId_fkey";
ALTER TABLE "tls_activities" DROP CONSTRAINT IF EXISTS "tls_activities_talosId_fkey";
ALTER TABLE "tls_approvals" DROP CONSTRAINT IF EXISTS "tls_approvals_talosId_fkey";
ALTER TABLE "tls_revenues" DROP CONSTRAINT IF EXISTS "tls_revenues_talosId_fkey";
ALTER TABLE "tls_dividends" DROP CONSTRAINT IF EXISTS "tls_dividends_talosId_fkey";
ALTER TABLE "tls_commerce_services" DROP CONSTRAINT IF EXISTS "tls_commerce_services_talosId_fkey";
ALTER TABLE "tls_commerce_jobs" DROP CONSTRAINT IF EXISTS "tls_commerce_jobs_talosId_fkey";
ALTER TABLE "tls_playbooks" DROP CONSTRAINT IF EXISTS "tls_playbooks_talosId_fkey";
ALTER TABLE "tls_api_audit_logs" DROP CONSTRAINT IF EXISTS "tls_api_audit_logs_talosId_fkey";

-- Recreate foreign key constraints with RESTRICT instead of CASCADE
ALTER TABLE "tls_patrons" ADD CONSTRAINT "tls_patrons_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_activities" ADD CONSTRAINT "tls_activities_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_approvals" ADD CONSTRAINT "tls_approvals_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_revenues" ADD CONSTRAINT "tls_revenues_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_dividends" ADD CONSTRAINT "tls_dividends_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_commerce_services" ADD CONSTRAINT "tls_commerce_services_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_commerce_jobs" ADD CONSTRAINT "tls_commerce_jobs_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_playbooks" ADD CONSTRAINT "tls_playbooks_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "tls_api_audit_logs" ADD CONSTRAINT "tls_api_audit_logs_talosId_fkey" 
  FOREIGN KEY ("talosId") REFERENCES "tls_talos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
