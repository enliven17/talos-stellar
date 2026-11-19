CREATE TABLE "tls_api_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"statusCode" integer NOT NULL,
	"ipAddress" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tls_dividends" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"amount" numeric(18, 6) NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"patronCount" integer DEFAULT 0 NOT NULL,
	"totalPulse" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'revenue-share' NOT NULL,
	"txHash" text,
	"breakdown" jsonb,
	"status" text DEFAULT 'completed' NOT NULL,
	"distributionId" text,
	"retryCount" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"retryable" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	CONSTRAINT "tls_dividends_distributionId_unique" UNIQUE("distributionId")
);
--> statement-breakpoint
CREATE TABLE "tls_lifecycle_events" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"sequence" integer NOT NULL,
	"eventType" text NOT NULL,
	"fromState" text,
	"toState" text NOT NULL,
	"actorId" text NOT NULL,
	"actorRole" text NOT NULL,
	"jobId" text,
	"stepName" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotencyKey" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tls_provisioning_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"lastError" text,
	"leasedBy" text,
	"leaseExpiresAt" timestamp (3),
	"fencingToken" integer DEFAULT 0 NOT NULL,
	"requestedBy" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	"completedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "tls_reputation_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"jobId" text NOT NULL,
	"requesterTalosId" text NOT NULL,
	"status" text NOT NULL,
	"jobCreatedAt" timestamp (3) NOT NULL,
	"jobUpdatedAt" timestamp (3),
	"deadlineAt" timestamp (3),
	"refundAmount" numeric(18, 6),
	"hasResult" boolean DEFAULT false NOT NULL,
	"txHash" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL,
	CONSTRAINT "tls_reputation_inputs_jobId_unique" UNIQUE("jobId")
);
--> statement-breakpoint
CREATE TABLE "tls_token_purchases" (
	"txHash" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"buyerPublicKey" text NOT NULL,
	"amount" integer NOT NULL,
	"totalCost" numeric(18, 6) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"responseBody" jsonb,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_activities" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_approvals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_commerce_services" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_patrons" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_revenues" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_talos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tls_patrons" DROP CONSTRAINT "tls_patrons_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_activities" DROP CONSTRAINT "tls_activities_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" DROP CONSTRAINT "tls_commerce_jobs_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_commerce_services" DROP CONSTRAINT "tls_commerce_services_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_approvals" DROP CONSTRAINT "tls_approvals_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_revenues" DROP CONSTRAINT "tls_revenues_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_playbooks" DROP CONSTRAINT "tls_playbooks_talosId_fkey";
--> statement-breakpoint
ALTER TABLE "tls_playbook_purchases" DROP CONSTRAINT "tls_playbook_purchases_playbookId_fkey";
--> statement-breakpoint
DROP INDEX "tls_talos_apiKey_key";--> statement-breakpoint
DROP INDEX "tls_commerce_services_talosId_key";--> statement-breakpoint
DROP INDEX "tls_patrons_talosId_stellarPublicKey_key";--> statement-breakpoint
DROP INDEX "tls_activities_talosId_createdAt_idx";--> statement-breakpoint
DROP INDEX "tls_commerce_jobs_talosId_status_idx";--> statement-breakpoint
DROP INDEX "tls_approvals_talosId_status_idx";--> statement-breakpoint
DROP INDEX "tls_revenues_talosId_createdAt_idx";--> statement-breakpoint
DROP INDEX "tls_playbooks_talosId_idx";--> statement-breakpoint
DROP INDEX "tls_playbook_purchases_playbookId_buyerPublicKey_key";--> statement-breakpoint
ALTER TABLE "tls_talos" ALTER COLUMN "channels" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "tls_talos" ALTER COLUMN "channels" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ALTER COLUMN "chains" SET DEFAULT '{"stellar"}';--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ALTER COLUMN "chains" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_playbooks" ALTER COLUMN "tags" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "tls_playbooks" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "onChainId" integer;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "agentName" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "tokenSymbol" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "walletPublicKey" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "creatorPublicKey" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "investorPublicKey" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "treasuryPublicKey" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "agentWalletId" text;--> statement-breakpoint
ALTER TABLE "tls_talos" ADD COLUMN "agentWalletAddress" text;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "requesterTalosId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "txHash" text;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "bidPrice" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "idempotencyResponse" jsonb;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "leasedBy" text;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "leasedAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "leaseExpiresAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD COLUMN "fencingToken" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ADD COLUMN "fulfillmentMode" text DEFAULT 'async' NOT NULL;--> statement-breakpoint
ALTER TABLE "tls_approvals" ADD COLUMN "txHash" text;--> statement-breakpoint
ALTER TABLE "tls_playbooks" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "tls_api_audit_logs" ADD CONSTRAINT "tls_api_audit_logs_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_dividends" ADD CONSTRAINT "tls_dividends_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_lifecycle_events" ADD CONSTRAINT "tls_lifecycle_events_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_provisioning_jobs" ADD CONSTRAINT "tls_provisioning_jobs_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_reputation_inputs" ADD CONSTRAINT "tls_reputation_inputs_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_token_purchases" ADD CONSTRAINT "tls_token_purchases_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tls_api_audit_logs_talosId_createdAt_idx" ON "tls_api_audit_logs" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE INDEX "tls_dividends_talosId_createdAt_idx" ON "tls_dividends" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "tls_dividends_talosId_distributionId_key" ON "tls_dividends" USING btree ("talosId","distributionId");--> statement-breakpoint
CREATE UNIQUE INDEX "tls_lifecycle_events_talosId_sequence_key" ON "tls_lifecycle_events" USING btree ("talosId","sequence");--> statement-breakpoint
CREATE INDEX "tls_lifecycle_events_talosId_createdAt_idx" ON "tls_lifecycle_events" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "tls_lifecycle_events_talosId_idempotencyKey_unique" ON "tls_lifecycle_events" USING btree ("talosId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tls_provisioning_jobs_talosId_idempotencyKey_unique" ON "tls_provisioning_jobs" USING btree ("talosId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "tls_provisioning_jobs_status_idx" ON "tls_provisioning_jobs" USING btree ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "tls_provisioning_jobs_talosId_createdAt_idx" ON "tls_provisioning_jobs" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE INDEX "tls_reputation_inputs_talosId_jobCreatedAt_idx" ON "tls_reputation_inputs" USING btree ("talosId","jobCreatedAt");--> statement-breakpoint
CREATE INDEX "tls_reputation_inputs_talosId_requester_idx" ON "tls_reputation_inputs" USING btree ("talosId","requesterTalosId");--> statement-breakpoint
CREATE INDEX "tls_token_purchases_talosId_createdAt_idx" ON "tls_token_purchases" USING btree ("talosId","createdAt");--> statement-breakpoint
ALTER TABLE "tls_patrons" ADD CONSTRAINT "tls_patrons_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_activities" ADD CONSTRAINT "tls_activities_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD CONSTRAINT "tls_commerce_jobs_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ADD CONSTRAINT "tls_commerce_services_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_approvals" ADD CONSTRAINT "tls_approvals_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_revenues" ADD CONSTRAINT "tls_revenues_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_playbooks" ADD CONSTRAINT "tls_playbooks_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tls_playbook_purchases" ADD CONSTRAINT "tls_playbook_purchases_playbookId_tls_playbooks_id_fk" FOREIGN KEY ("playbookId") REFERENCES "public"."tls_playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tls_commerce_jobs_talosId_idempotencyKey_unique" ON "tls_commerce_jobs" USING btree ("talosId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tls_patrons_talosId_stellarPublicKey_key" ON "tls_patrons" USING btree ("talosId","stellarPublicKey");--> statement-breakpoint
CREATE INDEX "tls_activities_talosId_createdAt_idx" ON "tls_activities" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE INDEX "tls_commerce_jobs_talosId_status_idx" ON "tls_commerce_jobs" USING btree ("talosId","status");--> statement-breakpoint
CREATE INDEX "tls_approvals_talosId_status_idx" ON "tls_approvals" USING btree ("talosId","status");--> statement-breakpoint
CREATE INDEX "tls_revenues_talosId_createdAt_idx" ON "tls_revenues" USING btree ("talosId","createdAt");--> statement-breakpoint
CREATE INDEX "tls_playbooks_talosId_idx" ON "tls_playbooks" USING btree ("talosId");--> statement-breakpoint
CREATE UNIQUE INDEX "tls_playbook_purchases_playbookId_buyerPublicKey_key" ON "tls_playbook_purchases" USING btree ("playbookId","buyerPublicKey");--> statement-breakpoint
ALTER TABLE "tls_talos" DROP COLUMN "apiEndpoint";--> statement-breakpoint
ALTER TABLE "tls_talos" DROP COLUMN "stellarPublicKey";--> statement-breakpoint
ALTER TABLE "tls_talos" DROP COLUMN "creatorAddress";--> statement-breakpoint
ALTER TABLE "tls_patrons" DROP COLUMN "worldIdHash";--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" DROP COLUMN "requestertalosId";--> statement-breakpoint
ALTER TABLE "tls_talos" ADD CONSTRAINT "tls_talos_onChainId_unique" UNIQUE("onChainId");--> statement-breakpoint
ALTER TABLE "tls_talos" ADD CONSTRAINT "tls_talos_agentName_unique" UNIQUE("agentName");--> statement-breakpoint
ALTER TABLE "tls_talos" ADD CONSTRAINT "tls_talos_apiKey_unique" UNIQUE("apiKey");--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD CONSTRAINT "tls_commerce_jobs_paymentSig_unique" UNIQUE("paymentSig");--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ADD CONSTRAINT "tls_commerce_services_talosId_unique" UNIQUE("talosId");