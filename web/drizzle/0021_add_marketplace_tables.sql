CREATE TABLE IF NOT EXISTS "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "capabilities_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"price" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider" text NOT NULL,
	"rating" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL REFERENCES "marketplace_items"("id"),
	"capability_id" uuid NOT NULL REFERENCES "capabilities"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capabilities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "anon_read_capabilities" ON "capabilities" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_capabilities" ON "capabilities" FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_capabilities" ON "capabilities" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "marketplace_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "anon_read_marketplace_items" ON "marketplace_items" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_marketplace_items" ON "marketplace_items" FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_marketplace_items" ON "marketplace_items" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "item_capabilities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "anon_read_item_capabilities" ON "item_capabilities" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "auth_read_item_capabilities" ON "item_capabilities" FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_item_capabilities" ON "item_capabilities" FOR ALL TO postgres USING (true) WITH CHECK (true);
