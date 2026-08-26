-- Add leased-job ownership and fencing support to commerce jobs.
--
-- Lease contract for async job fulfillment
-- ─────────────────────────────────────────
-- When an agent picks up a pending job it acquires a time-limited lease.
-- The lease prevents duplicate execution by concurrent agent processes.
--
-- leasedBy        — talosId of the agent holding the lease (NULL = available)
-- leasedAt        — when the lease was acquired
-- leaseExpiresAt  — when the lease expires (server-enforced TTL)
-- fencingToken    — monotonic counter bumped on each lease acquisition;
--                   the caller must present the current token when
--                   submitting a result, preventing stale workers from
--                   completing a job after the lease has been taken over.

ALTER TABLE "tls_commerce_jobs"
  ADD COLUMN IF NOT EXISTS "leasedBy" text,
  ADD COLUMN IF NOT EXISTS "leasedAt" timestamp(3) with time zone,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" timestamp(3) with time zone,
  ADD COLUMN IF NOT EXISTS "fencingToken" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_commerce_jobs_lease_idx"
  ON "tls_commerce_jobs" ("leasedBy", "leaseExpiresAt")
  WHERE "status" = 'pending';
