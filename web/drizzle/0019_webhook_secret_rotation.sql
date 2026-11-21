-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0019: Zero-downtime webhook signing-secret rotation
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds previous-secret overlap columns so operators can rotate webhook signing
-- secrets without dropping verification for consumers still on the old secret.
--
-- During the grace window:
--   - Deliveries are dual-signed with current + previous secrets
--   - Consumers verifying with either secret succeed
-- After previous_secret_expires_at:
--   - Previous ciphertext is ignored (and may be cleared via finalize)
--
-- Also ensures the base webhook tables exist (idempotent) in case migration
-- 0013 was applied as SQL-only without matching Drizzle schema exports.
--
-- Rollback:
--   ALTER TABLE tls_webhook_subscriptions
--     DROP COLUMN IF EXISTS previous_secret_ciphertext,
--     DROP COLUMN IF EXISTS previous_secret_expires_at,
--     DROP COLUMN IF EXISTS secret_rotated_at;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tls_webhook_subscriptions (
  id                TEXT PRIMARY KEY,
  talos_id          TEXT NOT NULL REFERENCES tls_talos(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  signature_version INTEGER NOT NULL DEFAULT 1,
  event_types       TEXT[] NOT NULL DEFAULT '{}',
  description       TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tls_webhook_subscriptions_talos_id_idx
  ON tls_webhook_subscriptions(talos_id);

CREATE TABLE IF NOT EXISTS tls_webhook_deliveries (
  id                TEXT PRIMARY KEY,
  subscription_id   TEXT NOT NULL REFERENCES tls_webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  last_status_code  INTEGER,
  last_error        TEXT,
  last_attempt_at   TIMESTAMP(3),
  next_attempt_at   TIMESTAMP(3),
  completed_at      TIMESTAMP(3),
  response_body     TEXT,
  leased_by         TEXT,
  leased_at         TIMESTAMP(3),
  lease_expires_at  TIMESTAMP(3),
  fencing_token     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tls_webhook_deliveries_sub_id_payload_hash_unique
  ON tls_webhook_deliveries(subscription_id, payload_hash);

CREATE INDEX IF NOT EXISTS tls_webhook_deliveries_pending_idx
  ON tls_webhook_deliveries(next_attempt_at, status)
  WHERE status = ANY (ARRAY['pending', 'failed']);

ALTER TABLE tls_webhook_subscriptions
  ADD COLUMN IF NOT EXISTS previous_secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS previous_secret_expires_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS secret_rotated_at TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS tls_webhook_subscriptions_previous_expires_idx
  ON tls_webhook_subscriptions(previous_secret_expires_at)
  WHERE previous_secret_ciphertext IS NOT NULL;
