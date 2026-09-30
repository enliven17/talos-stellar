# 629 chore(devx): add a safe local test-data reset command

## Summary

Adds `db:reset-test-data` — a fail-closed command that truncates the local Talos
tables and optionally re-runs the canonical seed — reachable through the
existing interfaces as `pnpm stack:reset-data` (docker compose local stack) and
`pnpm --dir web run db:reset-test-data` (direct). It refuses to touch anything
that is not provably a loopback database, and never prints credentials.

## Related Issues

Closes #629

## What changed

| File | Change |
| --- | --- |
| `web/src/lib/local-test-data-reset.ts` | New. Validation, redaction, plan building, retry, and execution logic. Table set is derived from `src/db/schema.ts`. |
| `web/src/db/reset-test-data.ts` | New. Thin CLI entry: env loading, pg pool, seed subprocess, stdio. |
| `web/package.json` | `db:reset-test-data` script (additive). |
| `package.json` | `stack:reset-data` script (additive). |
| `scripts/local-stack.sh` | New `reset-data` subcommand; delegates to the package script. |
| `web/tests/local-test-data-reset.unit.test.ts` | New. 30 tests: positive, negative/fail-closed, boundary, privacy regression. No database required. |
| `scripts/local-stack.test.sh` | New. 6 shell tests for the compose wrapper using `docker`/`pnpm` stubs. |
| `docs/local-test-data-reset.md` | New. Behavior contract, failure matrix, operations notes. |
| `CONTRIBUTING.md` | Documents the command, the focused test commands, and four new failure messages. |

## Design notes

- **One source of truth.** The table list comes from the drizzle schema at
  runtime (`getTableName` over the exported tables) instead of a hand-maintained
  list, so a new table is covered automatically and the reset can never drift
  from the schema.
- **One destructive statement.** `TRUNCATE TABLE "…" RESTART IDENTITY CASCADE`.
  No `DROP`, no `DELETE`, no schema or migration changes; the schema explicitly
  records why `CASCADE` is safe here.
- **Existing interfaces reused.** Seeding delegates to the package's own
  `db:seed` script; the compose wrapper delegates to the package script rather
  than re-implementing anything in shell.
- **Routing is not a second decision point.** The compose wrapper refuses when
  postgres is down and otherwise exports the loopback URL; every other check
  lives in one place (`resolveResetTarget`).

## Acceptance criteria

- [x] Available through the current interface (`pnpm stack:reset-data`, `pnpm --dir web run db:reset-test-data`) without changing existing scripts.
- [x] Missing, malformed, boundary, retry, and dependency-failure inputs have defined behavior (see the matrix in `docs/local-test-data-reset.md`).
- [x] Errors are explicit and privacy-safe: only database name, host, port, table names, and row **counts** are printed; URLs are rendered credential-free; driver errors are scrubbed.
- [x] No types, migrations, or fixtures were required — nothing in `web/drizzle/**` or `web/src/db/schema.ts` changed.
- [x] Focused positive/negative/boundary/regression coverage added, plus a CI-runnable shell test.
- [x] Lint clean on the touched files.

## Fail-closed behavior (highlights)

| Condition | Result |
| --- | --- |
| Non-loopback host (Supabase, Railway, private network) | Refuse, exit 1. No override flag exists. |
| `NODE_ENV=production`, `VERCEL_ENV`, or `RAILWAY_ENVIRONMENT` set | Refuse, exit 1. |
| No `--yes` (and no `--dry-run`) | Refuse, exit 1, without opening a connection. |
| Unknown flag, positional arg, or `--flag=value` form | Refuse, exit 1. |
| Database missing modelled tables | Refuse, exit 1, pointing at `db:migrate`. |
| Server reports a different database than the URL named | Refuse, exit 1. |
| Unreachable database | Bounded retry (3 attempts), then report host:port with `pnpm stack:up`. |
| Seed fails after a successful truncate | Exit 1 and say so; never reports a partial success. |

## Local validation

```bash
pnpm --dir web exec vitest run tests/local-test-data-reset.unit.test.ts   # 30/30
bash scripts/local-stack.test.sh                                          # 6/6
pnpm --dir web exec eslint src/lib/local-test-data-reset.ts src/db/reset-test-data.ts tests/local-test-data-reset.unit.test.ts
pnpm --dir web exec tsc --noEmit
pnpm stack:reset-data --dry-run    # manual smoke against the local stack
pnpm stack:reset-data --yes --seed
```

## Compatibility, migration, and operational impact

- **No migration and no schema change.** `db:generate` produces no diff; no
  re-migration is needed after a reset, and the `drizzle` migrations schema is
  never touched.
- **No new required environment variable.** `TALOS_RESET_DATABASE_URL` is an
  optional override for the compose wrapper; an existing `DATABASE_URL` export
  already takes precedence over the compose default, and both are validated.
- **Backward compatible.** `stack:up`, `stack:reset`, `db:seed`, and
  `db:seed-demo` are unchanged. The new scripts are additive, so callers that do
  not use them are unaffected.
- **Operational posture.** This is a developer/operator convenience, not a
  production tool: hosted contexts and non-loopback hosts are refused by design.
  It is idempotent and safe to re-run.
- **Recovery.** Local data only, so there is no rollback: re-run with `--seed`,
  or `pnpm stack:reset` for a full volume-level reset.
- **Known pre-existing issues, untouched by this change:** repo-wide
  `tsc --noEmit` reports 103 errors in unrelated files (`tests/health.test.ts`,
  `packages/sdk`, `scripts/generate-schemas.ts`, …), and `pnpm --dir web run
  test:unit` has 6 pre-existing `health.test.ts` failures from calling route
  handlers with no request argument.

## Test plan

- [x] Positive: schema-derived plan, single truncate covering every modelled table, `--seed` gating, `--dry-run` making no changes, `--help`.
- [x] Negative: missing/remote/hosted target, missing confirmation, unknown args, unmigrated database, target mismatch, connection failure, seed failure.
- [x] Boundary: loopback allowlist edges (`127.0.0.0/8`, `::1`, `[::1]`, `127.0.0.1.evil.example`, `0.0.0.0`), `DIRECT_URL` fallback, retry bound and non-retryable errors, identifier quoting, IPv6 target.
- [x] Regression/privacy: passwords, secret assignments, and key material never appear in output, including when a driver error embeds the connection URL; argv carries no credentials.
- [x] Shell layer: refuses when postgres is down without invoking the CLI, wires the loopback URL, forwards flags, and keeps credentials out of argv.

## Out of scope

No dependency upgrades, no broad refactors, no production credentials, no UI
changes, no changes to `scripts/local-stack.bat` (Windows contributors use the
package script, documented in `docs/local-test-data-reset.md`).
