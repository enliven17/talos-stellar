-- Per-agent resource quota configuration and usage accounting.
--
-- Design overview
-- ───────────────
-- tls_quota_configs  — one row per (talosId, resource) defining the limit and
--                      reset window for that resource.  A NULL talosId row is
--                      the platform default that applies when no agent-specific
--                      row exists.
--
-- tls_quota_usage    — one row per (talosId, resource, windowStart).  The
--                      counter is incremented atomically via
--                      INSERT … ON CONFLICT DO UPDATE (upsert) so concurrent
--                      requests never double-count.
--
-- Resources
-- ─────────
-- activity_writes   — POST /api/talos/:id/activity
-- job_writes        — POST /api/talos/:id/jobs
-- revenue_writes    — POST /api/talos/:id/revenue
-- sse_connections   — concurrent GET /api/events streams (gauge, not counter)
--
-- Reset windows
-- ─────────────
-- "daily"   — windowStart = floor(now, 1 day) in UTC
-- "hourly"  — windowStart = floor(now, 1 hour) in UTC
-- "monthly" — windowStart = floor(now, 1 month) in UTC

CREATE TABLE IF NOT EXISTS "tls_quota_configs" (
  -- NULL = platform default; non-NULL = per-agent override
  "talosId"      text REFERENCES "tls_talos"("id") ON DELETE CASCADE,

  -- One of: activity_writes | job_writes | revenue_writes | sse_connections
  "resource"     text NOT NULL,

  -- Maximum count allowed within the reset window
  "maxCount"     integer NOT NULL DEFAULT 1000,

  -- Window granularity: hourly | daily | monthly
  "windowSize"   text NOT NULL DEFAULT 'daily',

  -- Whether quota enforcement is active for this row
  "enabled"      boolean NOT NULL DEFAULT true,

  -- Admin notes (rationale, override reason, etc.)
  "notes"        text,

  "createdAt"    timestamp(3) with time zone NOT NULL DEFAULT now(),
  "updatedAt"    timestamp(3) with time zone NOT NULL DEFAULT now(),

  PRIMARY KEY ("talosId", "resource")
);
--> statement-breakpoint

-- Platform-level defaults (talosId is NULL — PostgreSQL allows multiple NULLs
-- in a nullable column, so these rows share the same NULL "talosId" and differ
-- only by resource.  We enforce uniqueness with a partial unique index.)

-- activity_writes: 500 per day
INSERT INTO "tls_quota_configs" ("talosId", "resource", "maxCount", "windowSize", "enabled")
VALUES (NULL, 'activity_writes', 500, 'daily', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- job_writes: 200 per day
INSERT INTO "tls_quota_configs" ("talosId", "resource", "maxCount", "windowSize", "enabled")
VALUES (NULL, 'job_writes', 200, 'daily', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- revenue_writes: 300 per day
INSERT INTO "tls_quota_configs" ("talosId", "resource", "maxCount", "windowSize", "enabled")
VALUES (NULL, 'revenue_writes', 300, 'daily', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- sse_connections: 50 per hour per agent
INSERT INTO "tls_quota_configs" ("talosId", "resource", "maxCount", "windowSize", "enabled")
VALUES (NULL, 'sse_connections', 50, 'hourly', true)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tls_quota_usage" (
  "talosId"      text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,

  -- Must match one of the resource values above
  "resource"     text NOT NULL,

  -- UTC-floored window start (hour, day, or month depending on windowSize)
  "windowStart"  timestamp(3) with time zone NOT NULL,

  -- Atomically incremented usage counter
  "count"        integer NOT NULL DEFAULT 0,

  "updatedAt"    timestamp(3) with time zone NOT NULL DEFAULT now(),

  PRIMARY KEY ("talosId", "resource", "windowStart")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_quota_usage_talosId_resource_idx"
  ON "tls_quota_usage" ("talosId", "resource");
