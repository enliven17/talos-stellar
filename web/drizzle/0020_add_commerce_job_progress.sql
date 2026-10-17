-- Commerce job mid-flight progress (percent / stage / message).
-- Additive only: nullable jsonb column, safe to apply live with no downtime.
-- Consumers: POST/GET /api/jobs/:id/progress (SSE). Rollback: DROP COLUMN.

ALTER TABLE "tls_commerce_jobs"
  ADD COLUMN IF NOT EXISTS "progress" jsonb;
