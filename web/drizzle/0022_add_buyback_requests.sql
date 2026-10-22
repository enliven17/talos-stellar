-- Idempotency ledger for POST /api/talos/:id/revenue/buyback (Idempotency-Key header).
-- Additive only: new table, safe to apply live. Rollback: DROP TABLE "tls_buyback_requests".

CREATE TABLE IF NOT EXISTS "tls_buyback_requests" (
  "talosId" text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "idempotencyKey" text NOT NULL,
  "requestHash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "responseBody" jsonb,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tls_buyback_requests_talosId_idempotencyKey_key"
  ON "tls_buyback_requests" ("talosId", "idempotencyKey");
