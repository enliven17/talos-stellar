-- Add client-supplied idempotency key to commerce jobs.
--
-- Idempotency contract for POST /api/talos/:id/jobs
-- ──────────────────────────────────────────────────
-- The caller may include an `Idempotency-Key` header on any POST.
-- The value is scoped per talosId so the same key may be reused across
-- different agents without collision.
--
-- Lifecycle:
--   New key   → job is created normally; key + cached response body stored.
--   Same key, same payload → original 201 response returned from cache.
--   Same key, different payload → 409 Conflict (conflicting reuse rejected).
--   Concurrent requests with same key → second INSERT hits the unique
--               constraint and receives a 409 immediately.
--
-- The partial unique index (WHERE "idempotencyKey" IS NOT NULL) enforces
-- uniqueness at the database level without touching rows that carry no key.

ALTER TABLE "tls_commerce_jobs"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" text,
  ADD COLUMN IF NOT EXISTS "idempotencyResponse" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_commerce_jobs_talosId_idempotencyKey_unique"
  ON "tls_commerce_jobs" ("talosId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
