CREATE MATERIALIZED VIEW IF NOT EXISTS "tls_leaderboard_aggregates" AS
SELECT
  t."id" AS "talosId",
  coalesce(p."cnt", 0)::int AS "patronCount",
  coalesce(a."cnt", 0)::int AS "activityCount",
  coalesce(r."total", 0)::float AS "totalRevenue"
FROM "tls_talos" t
LEFT JOIN (
  SELECT "talosId", count(*)::int AS "cnt" FROM "tls_patrons" GROUP BY "talosId"
) p ON p."talosId" = t."id"
LEFT JOIN (
  SELECT "talosId", count(*)::int AS "cnt" FROM "tls_activities" GROUP BY "talosId"
) a ON a."talosId" = t."id"
LEFT JOIN (
  SELECT "talosId", coalesce(sum("amount"), 0)::float AS "total" FROM "tls_revenues" GROUP BY "talosId"
) r ON r."talosId" = t."id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_leaderboard_aggregates_talosId_idx"
  ON "tls_leaderboard_aggregates" ("talosId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_leaderboard_aggregates_rank_idx"
  ON "tls_leaderboard_aggregates" ("totalRevenue" DESC, "talosId" DESC);
  --> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "tls_leaderboard_aggregates" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "tls_leaderboard_aggregates" FROM authenticated;
  END IF;
END $$;