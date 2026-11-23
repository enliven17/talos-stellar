-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0023: Webhook destination verification handshake
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds destination verification columns to verify control of configured
-- destinations before enabling deliveries, with bounded verification lifetime.
--
-- Rollback:
--   ALTER TABLE tls_webhook_subscriptions
--     DROP COLUMN IF EXISTS destination_verification_status,
--     DROP COLUMN IF EXISTS destination_verification_token,
--     DROP COLUMN IF EXISTS destination_verification_expires_at,
--     DROP COLUMN IF EXISTS destination_verified_at;
-- ─────────────────────────────────────────────────────────────────────────────

-- Existing rows keep destination_verification_status = NULL, which the
-- application treats as legacy-verified so current deliveries are unaffected.
-- New subscriptions are inserted with 'pending' and must complete the handshake.

ALTER TABLE tls_webhook_subscriptions
  ADD COLUMN IF NOT EXISTS destination_verification_status TEXT,
  ADD COLUMN IF NOT EXISTS destination_verification_token TEXT,
  ADD COLUMN IF NOT EXISTS destination_verification_expires_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS destination_verified_at TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS tls_webhook_subscriptions_verification_expires_idx
  ON tls_webhook_subscriptions(destination_verification_expires_at)
  WHERE destination_verification_status = 'pending';
