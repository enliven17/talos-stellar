-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "tls_talos" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"stellarAssetCode" text,
	"totalSupply" integer DEFAULT 1000000 NOT NULL,
	"creatorShare" integer DEFAULT 60 NOT NULL,
	"investorShare" integer DEFAULT 25 NOT NULL,
	"treasuryShare" integer DEFAULT 15 NOT NULL,
	"apiEndpoint" text,
	"apiKey" text,
	"persona" text,
	"targetAudience" text,
	"channels" text[] DEFAULT '{"stellar"}',
	"toneVoice" text,
	"approvalThreshold" numeric(18, 2) DEFAULT '10' NOT NULL,
	"gtmBudget" numeric(18, 2) DEFAULT '200' NOT NULL,
	"agentOnline" boolean DEFAULT false NOT NULL,
	"agentLastSeen" timestamp(3),
	"walletPublicKey" text,
	"creatorPublicKey" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	"pulsePrice" numeric(18, 6) DEFAULT '0' NOT NULL,
	"minPatronPulse" integer
);
--> statement-breakpoint
ALTER TABLE "tls_talos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_patrons" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"stellarPublicKey" text NOT NULL,
	"role" text NOT NULL,
	"share" numeric(5, 2) NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL,
	"pulseAmount" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_patrons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"type" text NOT NULL,
	"content" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_commerce_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"requesterTalosId" text NOT NULL,
	"serviceName" text NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"paymentSig" text,
	"amount" numeric(18, 6) NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_commerce_services" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"serviceName" text NOT NULL,
	"description" text,
	"price" numeric(18, 6) NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"stellarPublicKey" text NOT NULL,
	"chains" text[] DEFAULT '{"stellar"}',
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" numeric(18, 6),
	"status" text DEFAULT 'pending' NOT NULL,
	"decidedAt" timestamp(3),
	"decidedBy" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_revenues" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"amount" numeric(18, 6) NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"source" text NOT NULL,
	"txHash" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_revenues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tls_playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"description" text NOT NULL,
	"price" numeric(18, 6) NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tags" text[] DEFAULT '{"stellar"}',
	"status" text DEFAULT 'active' NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"engagementRate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"periodDays" integer DEFAULT 30 NOT NULL,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tls_playbook_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"playbookId" text NOT NULL,
	"buyerPublicKey" text NOT NULL,
	"appliedAt" timestamp(3),
	"txHash" text,
	"createdAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_patrons" ADD CONSTRAINT "tls_patrons_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_activities" ADD CONSTRAINT "tls_activities_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ADD CONSTRAINT "tls_commerce_jobs_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ADD CONSTRAINT "tls_commerce_services_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_approvals" ADD CONSTRAINT "tls_approvals_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_revenues" ADD CONSTRAINT "tls_revenues_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_playbooks" ADD CONSTRAINT "tls_playbooks_talosId_fkey" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tls_playbook_purchases" ADD CONSTRAINT "tls_playbook_purchases_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "public"."tls_playbooks"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "tls_talos_apiKey_key" ON "tls_talos" USING btree ("apiKey" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tls_patrons_talosId_stellarPublicKey_key" ON "tls_patrons" USING btree ("talosId" text_ops,"stellarPublicKey" text_ops);--> statement-breakpoint
CREATE INDEX "tls_activities_talosId_createdAt_idx" ON "tls_activities" USING btree ("talosId" text_ops,"createdAt" text_ops);--> statement-breakpoint
CREATE INDEX "tls_commerce_jobs_talosId_status_idx" ON "tls_commerce_jobs" USING btree ("talosId" text_ops,"status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tls_commerce_services_talosId_key" ON "tls_commerce_services" USING btree ("talosId" text_ops);--> statement-breakpoint
CREATE INDEX "tls_approvals_talosId_status_idx" ON "tls_approvals" USING btree ("talosId" text_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "tls_revenues_talosId_createdAt_idx" ON "tls_revenues" USING btree ("talosId" text_ops,"createdAt" text_ops);--> statement-breakpoint
CREATE INDEX "tls_playbooks_talosId_idx" ON "tls_playbooks" USING btree ("talosId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "tls_playbook_purchases_playbookId_buyerPublicKey_key" ON "tls_playbook_purchases" USING btree ("playbookId" text_ops,"buyerPublicKey" text_ops);
*/