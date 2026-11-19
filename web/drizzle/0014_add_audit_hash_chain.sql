-- Add tamper-evident hash chain columns to audit log
ALTER TABLE "tls_api_audit_logs" ADD COLUMN "sequenceNumber" integer;
--> statement-breakpoint
ALTER TABLE "tls_api_audit_logs" ADD COLUMN "previousHash" text;
--> statement-breakpoint
ALTER TABLE "tls_api_audit_logs" ADD COLUMN "entryHash" text;
--> statement-breakpoint
ALTER TABLE "tls_api_audit_logs" ADD COLUMN "chainVersion" text;
