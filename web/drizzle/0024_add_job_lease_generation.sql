-- Monotonic lease generation fencing token for background jobs.
-- Incremented on every leaseBatch() claim and never reset, so any stale worker
-- whose lease was reaped and replaced is rejected when applying side effects or
-- finalizing job results.
ALTER TABLE "tls_jobs"
  ADD COLUMN IF NOT EXISTS "leaseGeneration" integer DEFAULT 0 NOT NULL;
