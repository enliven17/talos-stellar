# Safe Local Test-Data Reset (Issue #629)

`db:reset-test-data` clears the local Talos test data — and optionally re-seeds
it — without recreating the stack. It exists because the alternatives were both
too blunt and too easy to point at the wrong database:

| | Effect | Problem |
| --- | --- | --- |
| `pnpm stack:reset` | `docker compose down -v` + `up` | Destroys the Postgres volume, the container state, and every unrelated local row. |
| `pnpm --dir web run db:seed` | Deletes a fixed list of tables, then inserts demo data | Implicitly destructive, and its table list is maintained by hand. |
| `pnpm stack:reset-data` | Truncates the modelled tables of a **loopback** database, optionally re-seeds | — |

---

## Exact commands

POSIX shells, against the docker compose stack:

```bash
pnpm stack:reset-data --dry-run      # preview the tables and row counts
pnpm stack:reset-data --yes          # truncate local test data
pnpm stack:reset-data --yes --seed   # truncate, then re-run db:seed
```

Directly from `web/` (uses the app's `DATABASE_URL`, i.e. `web/.env.local`):

```bash
pnpm --dir web run db:reset-test-data --dry-run
pnpm --dir web run db:reset-test-data --yes --seed
```

Windows PowerShell (the compose wrapper is POSIX-only; run the package script):

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/talos"
pnpm --dir web run db:reset-test-data --dry-run
pnpm --dir web run db:reset-test-data --yes --seed
```

`--yes` is required to destroy anything; `--dry-run` needs no confirmation.
There is deliberately no "force" or "skip validation" flag.

---

## What it does

1. Validates the environment and the target (see the contract below).
2. Connects with a bounded retry (3 attempts, backoff) so a stack that is still
   starting reports a clear dependency error instead of hanging.
3. Refuses if any table modelled in [`web/src/db/schema.ts`](../web/src/db/schema.ts)
   is missing from the database — the signature of an unmigrated database.
4. Reports the resolved target, table count, and current row counts.
5. Runs one `TRUNCATE TABLE "<t1>", "<t2>", … RESTART IDENTITY CASCADE`, i.e. the
   single source of truth is the drizzle schema, not a hand-written list.
6. With `--seed`, re-runs the canonical `db:seed` script as a child process.

## What it does **not** do

- It never drops, alters, or creates schema objects, and it never touches the
  `drizzle` migrations schema — no re-migration is needed afterwards.
- It never removes docker volumes, the database itself, or `.env` files.
- It never sells, mints, or signs anything on-chain; local row deletion does not
  affect Stellar testnet state that was already settled.
- It does not reseed unless you ask for `--seed` (the database is left empty).

---

## Safety contract

| Input / condition | Behavior |
| --- | --- |
| `DATABASE_URL` unset (and `DIRECT_URL` unset) | Refuse, exit 1: `DATABASE_URL is not set`. |
| `DATABASE_URL` not a `postgres://` / `postgresql://` URL | Refuse, exit 1. |
| URL without a user, without a database name, or with an invalid/out-of-range port | Refuse, exit 1. |
| Host is not `localhost`, `127.0.0.0/8`, or `::1` | Refuse, exit 1: `non-local host`. Includes Supabase, Railway, and any private-network host. There is **no** override flag. |
| `NODE_ENV=production`, `VERCEL_ENV`, or `RAILWAY_ENVIRONMENT` is set | Refuse, exit 1 — hosted deployments are out of scope. |
| Both `DATABASE_URL` and `DIRECT_URL` are set | `DATABASE_URL` wins (same precedence as `src/db/index.ts`); a stale remote `DIRECT_URL` cannot redirect the reset. |
| No `--yes` (and no `--dry-run`) | Refuse, exit 1, and never even open a connection. |
| Unknown flag or positional argument (`--force`, `--yes=true`, `talos`) | Refuse, exit 1. Ambiguous input never selects a different behavior. |
| Server reports a different database than the URL named (pooler/proxy rewrite) | Refuse, exit 1: never reset a database you did not name. |
| Database missing modelled tables | Refuse, exit 1, pointing at `db:migrate`. |
| Database unreachable, wrong credentials, or still starting | Retry transient errors, then fail with host:port and `pnpm stack:up` guidance. |
| Seed step fails after a successful truncate | Exit 1, state it explicitly, and print the exact `db:seed` command to recover. |
| `pnpm stack:reset-data` while the stack is down | Refuse, exit 1, and never invoke the reset CLI. |

**Privacy.** Only the database name, host, port, table names, and row *counts* are
printed. Connection URLs are rendered as `protocol://user@host:port/database` —
passwords, query parameters (pooler tokens), and row contents are never logged,
and driver errors are scrubbed of credentials and key material before printing.
Payment proofs, agent seeds, and API keys are local rows, so they are destroyed
by a reset rather than displayed.

---

## Compatibility, migration, and operations

- **No schema change, no migration, no new required environment variable.**
  `pnpm --dir web run db:generate` produces no diff for this change.
- **Existing callers are unaffected**: `stack:up`, `stack:reset`, `db:seed`, and
  `db:seed-demo` keep their current behavior. `stack:reset-data` is additive.
- `TALOS_RESET_DATABASE_URL` optionally overrides the URL the compose wrapper
  uses; an existing `DATABASE_URL` export already takes precedence over the
  compose default. Both are still validated for locality.
- The command is safe to run repeatedly — truncate is idempotent and the seed is
  the same script the stack runs on boot.

### Recovery

Local data only, so there is nothing to roll back: re-run
`pnpm stack:reset-data --yes --seed` to get a clean seeded database, or
`pnpm stack:reset` for a full volume-level reset.

---

## Tests

```bash
# Behavior, safety, and privacy coverage (no database required)
pnpm --dir web exec vitest run tests/local-test-data-reset.unit.test.ts

# Shell layer: stack-down refusal, URL wiring, argv hygiene
bash scripts/local-stack.test.sh
```
