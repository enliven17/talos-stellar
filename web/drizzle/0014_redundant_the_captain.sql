CREATE TABLE "tls_reputations" (
	"id" text PRIMARY KEY NOT NULL,
	"talosId" text NOT NULL,
	"serviceName" text NOT NULL,
	"score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"confidence" numeric(5, 2) DEFAULT '0' NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"freshness" timestamp (3) DEFAULT now() NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"safeReason" jsonb,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tls_reputations" ADD CONSTRAINT "tls_reputations_talosId_tls_talos_id_fk" FOREIGN KEY ("talosId") REFERENCES "public"."tls_talos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tls_reputations_talosId_serviceName_key" ON "tls_reputations" USING btree ("talosId","serviceName");
--> statement-breakpoint
CREATE INDEX "tls_reputations_talosId_idx" ON "tls_reputations" USING btree ("talosId");
--> statement-breakpoint
CREATE INDEX "tls_reputations_serviceName_idx" ON "tls_reputations" USING btree ("serviceName");