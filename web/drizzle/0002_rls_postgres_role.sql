-- Allow postgres role full access (bypasses RLS for server-side API routes)
CREATE POLICY "postgres_all_talos" ON "tls_talos" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_patrons" ON "tls_patrons" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_activities" ON "tls_activities" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_approvals" ON "tls_approvals" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_revenues" ON "tls_revenues" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_commerce_services" ON "tls_commerce_services" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_commerce_jobs" ON "tls_commerce_jobs" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_playbooks" ON "tls_playbooks" FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "postgres_all_playbook_purchases" ON "tls_playbook_purchases" FOR ALL TO postgres USING (true) WITH CHECK (true);
