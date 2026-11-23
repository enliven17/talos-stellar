CREATE TABLE IF NOT EXISTS "tls_job_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"jobId" text NOT NULL,
	"attemptNumber" integer NOT NULL,
	"workerId" text,
	"leaseId" text,
	"startedAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp(3) with time zone,
	"durationMs" integer,
	"terminalReason" text NOT NULL,
	"error" text,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "tls_job_attempts_jobId_idx" ON "tls_job_attempts" ("jobId");
CREATE INDEX IF NOT EXISTS "tls_job_attempts_job_attempt_idx" ON "tls_job_attempts" ("jobId", "attemptNumber");
DO $$ BEGIN
 ALTER TABLE "tls_job_attempts" ADD CONSTRAINT "tls_job_attempts_jobId_tls_jobs_id_fk" FOREIGN KEY ("jobId") REFERENCES "tls_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
