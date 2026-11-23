CREATE TABLE IF NOT EXISTS "tls_outbox_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"consumerId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 8 NOT NULL,
	"nextRetryAt" timestamp (3) DEFAULT now() NOT NULL,
	"lastError" text,
	"ackedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tls_outbox_deliveries" ADD CONSTRAINT "tls_outbox_deliveries_eventId_tls_outbox_events_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."tls_outbox_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tls_outbox_deliveries_eventId_consumerId_unique" ON "tls_outbox_deliveries" USING btree ("eventId","consumerId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tls_outbox_deliveries_eventId_status_idx" ON "tls_outbox_deliveries" USING btree ("eventId","status");
