-- Add benchmark persistence tables for the devx benchmark framework.
--
-- These tables store benchmark run metadata and individual result records
-- so that performance trends can be tracked across CI runs and local development.

-- ─── Benchmark Runs ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tls_benchmark_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "suite" text NOT NULL,
  "config" jsonb NOT NULL,
  "summary" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'completed',
  "ci_run" boolean NOT NULL DEFAULT false,
  "commit_sha" text,
  "branch" text,
  "started_at" timestamp(3) NOT NULL DEFAULT now(),
  "completed_at" timestamp(3) NOT NULL DEFAULT now(),
  "created_at" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_benchmark_runs_suite_started_at_idx"
  ON "tls_benchmark_runs" ("suite", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_benchmark_runs_commit_sha_idx"
  ON "tls_benchmark_runs" ("commit_sha");

-- ─── Benchmark Results ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "tls_benchmark_results" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL REFERENCES "tls_benchmark_runs"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "passed" boolean NOT NULL,
  "mean_ms" numeric(18, 4) NOT NULL,
  "median_ms" numeric(18, 4) NOT NULL,
  "stddev_ms" numeric(18, 4) NOT NULL,
  "min_ms" numeric(18, 4) NOT NULL,
  "max_ms" numeric(18, 4) NOT NULL,
  "variance" numeric(10, 6) NOT NULL,
  "percentiles" jsonb NOT NULL,
  "mean_memory_mb" numeric(10, 2) NOT NULL,
  "peak_memory_mb" numeric(10, 2) NOT NULL,
  "mean_cpu_percent" numeric(6, 2) NOT NULL,
  "peak_cpu_percent" numeric(6, 2) NOT NULL,
  "threshold_violations" jsonb,
  "sample_count" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_benchmark_results_run_id_idx"
  ON "tls_benchmark_results" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_benchmark_results_label_passed_idx"
  ON "tls_benchmark_results" ("label", "passed");