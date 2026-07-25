CREATE TABLE "tls_reputation_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"serviceName" text NOT NULL,
	"jobId" text NOT NULL,
	"eventType" text NOT NULL,
	"amount" numeric(18, 6) DEFAULT '0' NOT NULL,
	"counterparty" text,
	"txHash" text,
	"paymentSig" text,
	"timestamp" timestamp (3) DEFAULT now() NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_reputation_ledger" ADD CONSTRAINT "tls_reputation_ledger_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tls_reputation_ledger_talosId_idx" ON "tls_reputation_ledger" USING btree ("talosId");--> statement-breakpoint
CREATE INDEX "tls_reputation_ledger_jobId_idx" ON "tls_reputation_ledger" USING btree ("jobId");--> statement-breakpoint
CREATE UNIQUE INDEX "tls_reputation_ledger_jobId_eventType_unique" ON "tls_reputation_ledger" USING btree ("jobId","eventType");