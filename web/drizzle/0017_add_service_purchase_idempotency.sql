-- Per-buyer idempotency for inter-agent service purchases.
--
-- The existing partial unique index on (talosId, idempotencyKey) scopes
-- idempotency per service provider.  For the service purchase endpoint
-- (POST /api/talos/:id/service) we also need per-buyer scoping so that
-- two different buyers can use the same key on the same service without
-- colliding.
--
-- This composite index covers the service purchase flow while leaving
-- the original index intact for the jobs endpoint.

CREATE UNIQUE INDEX IF NOT EXISTS "tls_commerce_jobs_talos_requester_idempotencyKey_unique"
  ON "tls_commerce_jobs" ("talosId", "requesterTalosId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
