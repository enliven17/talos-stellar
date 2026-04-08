-- Enable Row Level Security on all tables
ALTER TABLE "tls_talos" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_patrons" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_activities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_revenues" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_commerce_services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_commerce_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_playbooks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tls_playbook_purchases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Public read access (anon role)
CREATE POLICY "anon_read_talos" ON "tls_talos" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "anon_read_activities" ON "tls_activities" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "anon_read_revenues" ON "tls_revenues" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "anon_read_commerce_services" ON "tls_commerce_services" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "anon_read_playbooks" ON "tls_playbooks" FOR SELECT TO anon USING (true);
--> statement-breakpoint
CREATE POLICY "anon_read_patrons" ON "tls_patrons" FOR SELECT TO anon USING (true);
--> statement-breakpoint

-- Authenticated users: full read + scoped write
CREATE POLICY "auth_read_talos" ON "tls_talos" FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "auth_insert_talos" ON "tls_talos" FOR INSERT TO authenticated WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_update_talos" ON "tls_talos" FOR UPDATE TO authenticated USING (true);
--> statement-breakpoint
CREATE POLICY "auth_all_patrons" ON "tls_patrons" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_activities" ON "tls_activities" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_approvals" ON "tls_approvals" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_revenues" ON "tls_revenues" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_commerce_services" ON "tls_commerce_services" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_commerce_jobs" ON "tls_commerce_jobs" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_playbooks" ON "tls_playbooks" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_all_playbook_purchases" ON "tls_playbook_purchases" FOR ALL TO authenticated USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Note: service_role bypasses RLS by default in Supabase
