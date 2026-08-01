-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0013: Add webhook subscription and delivery tables
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration adds two tables:
--   1. tls_webhook_subscriptions — per-TALOS webhook endpoint configurations
--   2. tls_webhook_deliveries    — delivery history with retry and lease state
--
── Rollback:
--   DROP TABLE IF EXISTS tls_webhook_deliveries;
--   DROP TABLE IF EXISTS tls_webhook_subscriptions;
--
── Effects:
--   - New tables are created with FK references to tls_talos (CASCADE on delete)
--   - Indexes on talosId for efficient querying
--   - Unique constraint on (subscription_id, payload_hash) for duplicate prevention
--   - Delivery table uses the same fencing-token pattern as commerce jobs for
--     concurrent-safe lease acquisition
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Webhook Subscriptions ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tls_webhook_subscriptions (
  id                TEXT PRIMARY KEY,
  talos_id          TEXT NOT NULL REFERENCES tls_talos(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,          -- AES-256-GCM encrypted webhook secret
  signature_version INTEGER NOT NULL DEFAULT 1,
  event_types       TEXT[] NOT NULL DEFAULT '{}',
  description       TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tls_webhook_subscriptions_talos_id_idx
  ON tls_webhook_subscriptions(talos_id);

-- ─── Webhook Deliveries ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tls_webhook_deliveries (
  id                TEXT PRIMARY KEY,
  subscription_id   TEXT NOT NULL REFERENCES tls_webhook_subscriptions(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,           -- SHA-256 hex digest of payload JSON
  status            TEXT NOT NULL DEFAULT 'pending',
    -- pending | delivered | failed | dead_letter
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  last_status_code  INTEGER,                 -- HTTP status from last attempt
  last_error        TEXT,
  last_attempt_at   TIMESTAMP(3),
  next_attempt_at   TIMESTAMP(3),            -- For scheduled retry (exponential backoff)
  completed_at      TIMESTAMP(3),
  response_body     TEXT,                    -- Response body from last attempt (truncated)

  -- Lease fields (same pattern as tls_commerce_jobs)
  leased_by         TEXT,
  leased_at         TIMESTAMP(3),
  lease_expires_at  TIMESTAMP(3),
  fencing_token     INTEGER NOT NULL DEFAULT 0,

  created_at        TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Index for duplicate prevention (unique per subscription + payload hash)
CREATE UNIQUE INDEX IF NOT EXISTS tls_webhook_deliveries_sub_id_payload_hash_unique
  ON tls_webhook_deliveries(subscription_id, payload_hash);

-- Index for pending-delivery polling (used by workers)
CREATE INDEX IF NOT EXISTS tls_webhook_deliveries_pending_idx
  ON tls_webhook_deliveries(next_attempt_at, status)
  WHERE status = ANY (ARRAY['pending', 'failed']);
