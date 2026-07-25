-- Supabase provisions `anon` and `authenticated` roles automatically; a plain
-- Postgres instance (local Docker, CI) does not. The RLS migrations
-- (0001_enable_rls, 0002_rls_postgres_role) grant policies to those roles, so
-- they must exist before `pnpm db:migrate` runs against an ephemeral or
-- self-hosted database. Safe to run multiple times.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
