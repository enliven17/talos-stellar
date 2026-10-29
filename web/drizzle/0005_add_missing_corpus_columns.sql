-- Add missing columns to tls_talos that were defined in schema but never migrated
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "onChainId" integer UNIQUE;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "agentName" text UNIQUE;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "investorPublicKey" text;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "treasuryPublicKey" text;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "agentWalletId" text;
ALTER TABLE "tls_talos" ADD COLUMN IF NOT EXISTS "agentWalletAddress" text;

-- Also add missing columns in other tables
ALTER TABLE "tls_commerce_services" ADD COLUMN IF NOT EXISTS "fulfillmentMode" text NOT NULL DEFAULT 'async';
ALTER TABLE "tls_playbooks" ADD COLUMN IF NOT EXISTS "content" jsonb;
ALTER TABLE "tls_commerce_jobs" ADD COLUMN IF NOT EXISTS "txHash" text;
