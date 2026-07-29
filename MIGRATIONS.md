# Database Migrations Guide

`web/` uses Drizzle ORM with SQL migration files in [`web/drizzle`](web/drizzle). The
`Web Migrations CI` workflow ([`.github/workflows/web-migrations-ci.yml`](.github/workflows/web-migrations-ci.yml))
validates every migration against an ephemeral Postgres 16 service before merge.

## What CI checks

On any PR touching `web/drizzle/**`, `web/src/db/**`, or `web/drizzle.config.ts`:

1. **Fresh install** — applies all migrations in order to an empty database (`pnpm db:migrate`), catching ordering and syntax failures.
2. **Schema drift** — runs `pnpm db:generate` and fails the build if it produces changes that were not committed, meaning `schema.ts` and the migration files have diverged.
3. **Data preservation / idempotency** — seeds data (`pnpm db:seed`), records row counts, then re-runs `pnpm db:migrate` against that already-migrated database to confirm re-applying migrations is a no-op and existing data survives.
4. **Lock hygiene** — checks `pg_locks` after the run to catch an advisory lock left held by a crashed migrator.
5. **Timeout budget** — each `pnpm db:migrate` invocation is bounded with `timeout 120` and the job itself has a 15-minute cap, so a hung migration fails the build instead of hanging CI.
6. **Artifacts** — migration output is uploaded as a `migration-logs` workflow artifact (fresh run and replay) for post-mortem review, always, even on failure.

## Role bootstrap

The RLS migrations (`0001_enable_rls.sql`, `0002_rls_postgres_role.sql`) grant policies to
Supabase's `anon` and `authenticated` roles. Supabase provisions those automatically; a plain
Postgres instance (CI, local Docker) does not. [`web/drizzle/bootstrap-roles.sql`](web/drizzle/bootstrap-roles.sql)
creates them idempotently and must be run once against a fresh database before the first migration:

```bash
psql "$DIRECT_URL" -f web/drizzle/bootstrap-roles.sql
```

## Reproducing locally

```bash
docker run --rm -d --name talos-migrations-ci \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=talos_migrations_ci \
  -p 5432:5432 postgres:16

export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/talos_migrations_ci
export DIRECT_URL=$DATABASE_URL

cd web
psql "$DIRECT_URL" -f drizzle/bootstrap-roles.sql
pnpm install
pnpm db:migrate

docker stop talos-migrations-ci
```

## Rollback

These migrations are forward-only; there are no generated `down` scripts. To roll back a bad
migration:

1. Restore the database from the pre-migration snapshot/backup (Supabase point-in-time recovery,
   or your own `pg_dump` taken before deploying).
2. Write a new forward migration that reverses the change, rather than editing or deleting an
   already-merged migration file — migration files are treated as immutable history once merged.

Because of this, prefer additive, backward-compatible migrations (new nullable columns, new
tables) over destructive ones, and split destructive changes (drop column/table) into a separate,
later migration once the application no longer reads the old shape.

## Troubleshooting

- **`role "anon" does not exist` / `role "authenticated" does not exist`** — run
  `bootstrap-roles.sql` against the target database before migrating (see above). Supabase-hosted
  databases already have these roles.
- **Schema drift failure in CI** — you changed `web/src/db/schema.ts` without committing a
  matching migration. Run `pnpm db:generate` inside `web/` and commit the generated file(s) in
  `web/drizzle/`.- **Migration times out** — check the `migration-logs` artifact from the failed run; a hang
  usually means a lock is held by a concurrent migration or long-running transaction against
  the same database.

## Backup / DR

Migration `0013_add_backup_runs.sql` is **purely additive** — it adds the
`tls_backup_runs` table that records every backup, restore, and verify
operation. The migration does not alter any existing table and is forward
compatible with prior backups. Restore flows skip unknown tables in the
artifact and accept partial overlap with the live DB schema, so a backup
made against migration N+5 can be restored on a database that has already
been migrated to N+8 (one-way upgrade only).

See [`docs/DR_RUNBOOK.md`](docs/DR_RUNBOOK.md) for the related restore
endpoints, RPO/RTO targets, and the manifest format.
- **Advisory lock check fails** — a previous migrator run crashed mid-migration and left its lock
  held. On a real database, restart the connection pool holding the lock, or open a new session
  and run `SELECT pg_advisory_unlock_all();` after confirming no migration is genuinely in
  progress.
