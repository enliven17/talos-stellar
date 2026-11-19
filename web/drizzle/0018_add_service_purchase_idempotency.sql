-- Per-buyer idempotency for inter-agent service purchases.
--
-- The previous partial unique index on (talosId, idempotencyKey) scoped
-- idempotency per service *provider*, which would prevent two different
-- buyers from reusing the same idempotency key on the same service — a
-- conflict with the purchase contract where the key must be scoped per
-- buyer.
--
-- We drop that provider-scoped index and replace it with a composite
-- (talosId, requesterTalosId, idempotencyKey) index so that the same key
-- is safe to reuse across different buyers on the same service, while
-- still blocking duplicate jobs for the same buyer+service+key.

DROP INDEX IF EXISTS "tls_commerce_jobs_talosId_idempotencyKey_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "tls_commerce_jobs_talos_requester_idempotencyKey_unique"
  ON "tls_commerce_jobs" ("talosId", "requesterTalosId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
