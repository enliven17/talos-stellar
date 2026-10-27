-- Deterministic backup/restore CI fixture seed.
-- Used by Web Backups CI and web/tests/backup-restore-fixture.test.ts.
-- Keep ids stable so row-count and content assertions stay reviewable.
-- Local: psql "$DATABASE_URL" -f web/tests/fixtures/backup-restore/seed.sql

INSERT INTO tls_talos (id, name, category, description, status, "updatedAt")
  VALUES ('dr-test-1', 'DR Test', 'Operations', 'fixture', 'Active', CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO NOTHING;

INSERT INTO tls_patrons (id, "talosId", "stellarPublicKey", role, share, "updatedAt")
  VALUES ('dr-patron-1', 'dr-test-1', 'GABC', 'patron', 100.00, CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO NOTHING;

INSERT INTO tls_revenues (id, "talosId", amount, currency, source)
  VALUES ('dr-rev-1', 'dr-test-1', 10.5, 'USDC', 'dr-test')
  ON CONFLICT (id) DO NOTHING;
