-- Add idempotency and retry metadata to dividend distributions
ALTER TABLE "tls_dividends" ADD COLUMN "distributionId" text;
--> statement-breakpoint
ALTER TABLE "tls_dividends" ADD COLUMN "retryCount" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tls_dividends" ADD COLUMN "lastError" text;
--> statement-breakpoint
ALTER TABLE "tls_dividends" ADD COLUMN "retryable" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "tls_dividends" ADD COLUMN "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_dividends_talosId_distributionId_key"
  ON "tls_dividends"("talosId", "distributionId");
