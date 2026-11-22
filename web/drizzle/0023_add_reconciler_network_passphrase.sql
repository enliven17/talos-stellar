-- Add pinned Stellar network identity (passphrase) to transaction finality records
ALTER TABLE "tls_stellar_tx_records" ADD COLUMN IF NOT EXISTS "network_passphrase" text;
