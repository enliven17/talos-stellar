# Local Stack Troubleshooting Guide

This guide documents common setup failures, errors, and edge cases encountered when running the Talos Protocol local development stack.

The local stack is composed of:
- **Docker Compose Stack** (`docker-compose.yml`, `scripts/local-stack.sh`, `scripts/local-stack.bat`): PostgreSQL 16 (`talos-postgres`), Mock Stellar Horizon/RPC on port 4010 (`talos-mock-stellar`), and Next.js Web on port 3000 (`talos-web`), plus optional Prime Agent (`talos-prime-agent`).
- **Database Migrations** (`web/drizzle/`, `scripts/check-migration-drift.mjs`, `web/src/db/migrate.ts`): Drizzle ORM migrations and journal tracking.
- **Role Bootstrap** (`web/drizzle/bootstrap-roles.sql`): PostgreSQL role initialization for RLS policies.
- **Database Seeding & Seed Guard** (`web/src/db/seed-guard.ts`, `web/src/db/seed.ts`): Guardrails preventing accidental mutation of non-local databases.
- **Safe Test-Data Reset** (`web/src/lib/local-test-data-reset.ts`, `web/src/db/reset-test-data.ts`, `scripts/local-stack.sh`): Loopback-restricted table truncation.
- **Environment Templates** (`web/.env.example`, `packages/prime-agent/.env.example`, `contracts/.env.example`).
- **Toolchain Doctor** (`scripts/doctor.mjs`, `scripts/setup.sh`, `scripts/setup.bat`).

---

## Quick Reference: Symptom Matrix

| Scenario | Symptom / Error Snippet | Primary Cause | Quick Fix Command |
|---|---|---|---|
| **1. Port Conflict** | `Bind for 0.0.0.0:5432 failed: port is already allocated` or `EADDRINUSE ...:3000` | Host service or stale container holding port 5432, 4010, or 3000 | `lsof -i :5432` or `netstat -ano`; stop conflicting process; `pnpm stack:up` |
| **2. Stale Docker Volumes** | Web container crash loop; `relation "xyz" already exists` or column mismatch | Persistent `postgres-data` volume contains incompatible schema | `pnpm stack:reset` |
| **3. Seed Guard: Remote Host** | `Refusing to seed database host '<host>'. Use localhost, 127.0.0.1, ::1...` | `DATABASE_URL` points to remote DB (e.g. Supabase, AWS) | Point `DATABASE_URL` to local Postgres in `web/.env.local` |
| **4. Seed Guard: Production / Unset** | `Refusing to seed a production process` or `DATABASE_URL is not set` | `NODE_ENV=production` or missing environment variable | Set `NODE_ENV=development` and export local `DATABASE_URL` |
| **5. Migration Drift: Orphans / Collisions** | `error: orphan migration SQL not in journal` or `ambiguous numeric migration prefixes` | Uncommitted/untracked SQL files or shared migration prefixes from git branches | `pnpm migrations:check`; run `pnpm --dir web db:generate` or reconcile `_journal.json` |
| **6. Missing Role Bootstrap** | `error: role "anon" does not exist` or `role "authenticated" does not exist` | Fresh Postgres instance missing Supabase auth roles needed by RLS | `docker compose exec -T postgres psql -U postgres -d talos < web/drizzle/bootstrap-roles.sql` |
| **7. Test-Data Reset Refusal** | `Refusing to delete local test data without --yes (or use --dry-run to preview)` | Safe reset fails closed when unconfirmed or missing tables | `pnpm stack:reset-data --dry-run` then `pnpm stack:reset-data --yes --seed` |
| **8. Postgres Down During Reset** | `local-stack: the postgres service is not running. Start it first with: pnpm stack:up` | `stack:reset-data` invoked before stack containers are running | `pnpm stack:up` |
| **9. Missing Environment Variables** | `❌ Missing: DATABASE_URL` from `scripts/setup.sh` or missing Stellar keys | Missing `web/.env.local` or incomplete configuration | `cp web/.env.example web/.env.local`; review variables |
| **10. Mock Stellar Faults Active** | `[FAULT_INJECTION] ERROR: ...` or HTTP 500 / timeouts from port 4010 | `FAULT_INJECTION_ENABLED=true` left on from testing | `export FAULT_INJECTION_ENABLED=false`; `docker compose up -d mock-stellar` |
| **11. Toolchain Missing / Outdated** | `✗ Python 3.10 is too old` or `✗ uv not found` in `pnpm doctor` | Host machine missing prerequisite tool versions | `pnpm doctor`; upgrade Node >= 20, pnpm >= 9, Python >= 3.11, install `uv` |

---

## Scenario 1: Port Allocation Conflicts (5432, 4010, 3000)

### Symptoms
When starting the local stack (`pnpm stack:up` or `bash scripts/local-stack.sh up` / `scripts\local-stack.bat up`), Docker fails to bind to the host network interface:

```text
Error response from daemon: driver failed programming external connectivity on endpoint talos-postgres (or talos-mock-stellar, talos-web): Bind for 0.0.0.0:5432 failed: port is already allocated
```

Or when running the web app locally (`pnpm dev`):

```text
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

### Cause
Another process on the host machine is already listening on the required port:
- **Port 5432**: A system-installed PostgreSQL server (e.g., Homebrew service, systemd `postgresql`, or a Windows service), or an unrelated Docker container.
- **Port 4010**: A lingering mock Stellar instance, Prism mock server, or orphaned Node process.
- **Port 3000**: An existing Next.js dev server or another web application.

### Diagnostic Commands

POSIX (Linux / macOS):
```bash
# Check what is listening on ports 5432, 4010, and 3000
lsof -i :5432
lsof -i :4010
lsof -i :3000

# Or via ss
ss -tulpn | grep -E ':(5432|4010|3000)'
```

Windows PowerShell:
```powershell
Get-NetTCPConnection -LocalPort 5432, 4010, 3000 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess, State
```

Check running Docker containers publishing these ports:
```bash
docker ps --filter "publish=5432" --filter "publish=4010" --filter "publish=3000"
```

### Resolution

1. Stop host PostgreSQL if it is running as a local background daemon:
   ```bash
   # Ubuntu/Debian
   sudo systemctl stop postgresql

   # macOS (Homebrew)
   brew services stop postgresql@16

   # Windows (PowerShell as Admin)
   Stop-Service postgresql*
   ```

2. Terminate any orphaned Docker containers occupying the ports:
   ```bash
   docker stop $(docker ps -q --filter "publish=5432")
   docker stop $(docker ps -q --filter "publish=4010")
   docker stop $(docker ps -q --filter "publish=3000")
   ```

3. Restart the stack:
   ```bash
   pnpm stack:up
   ```

---

## Scenario 2: Stale Docker Volumes or Schema Incompatibilities

### Symptoms
After switching branches or pulling upstream changes, the stack starts up but the web container fails healthchecks:

```text
talos-web | healthcheck failed: wget -qO- http://127.0.0.1:3000/api/health/live returned exit 1
```

Inspecting container logs (`pnpm stack:logs` or `docker compose logs web`) shows database migration or schema mismatches:

```text
error: relation "tls_talos" already exists
```
or:
```text
error: column "..." does not exist in table "..."
```

### Cause
Docker Compose creates a named volume `postgres-data` (defined in `docker-compose.yml`), which persists PostgreSQL data files across container stops and restarts. When branch migrations diverge or rollback scripts are not applied, the database on disk is in an incompatible state with the code in `web/src/db/schema.ts` and `web/drizzle/`.

### Diagnostic Commands

Check status of the containers and view recent startup logs:
```bash
docker compose ps
pnpm stack:logs
```

Inspect PostgreSQL container logs directly:
```bash
docker compose logs postgres
```

### Resolution

Wipe the persistent volume and recreate the stack from scratch:

```bash
pnpm stack:reset
```

`pnpm stack:reset` executes:
```bash
docker compose down -v --remove-orphans
docker compose up -d postgres mock-stellar web
```

This destroys `postgres-data`, starts fresh containers, applies all Drizzle migrations, runs the seed script, and starts the web service.

> [!NOTE]
> If you only want to truncate tables and re-seed without destroying the entire Docker volume, use `pnpm stack:reset-data --yes --seed` instead (see Scenario 7).

---

## Scenario 3: Seed Guard Rejection on Remote Database Host

### Symptoms
When running database seed scripts (`pnpm --dir web run db:seed`, `pnpm web:db:seed`, or `pnpm --dir web run db:reset-test-data --seed`), the process aborts immediately:

```text
Error: Refusing to seed database host 'aws-0-eu-central-1.pooler.supabase.com'. Use localhost, 127.0.0.1, ::1, or the local Docker postgres service. Set ALLOW_UNSAFE_DB_SEED=true only for an intentional, reviewed override.
    at Module.assertSafeSeedDatabaseUrl (file:///.../web/src/db/seed-guard.ts:51:11)
```

### Cause
The seed guard in [`web/src/db/seed-guard.ts`](../web/src/db/seed-guard.ts) executes before any data deletion or insertion. It inspects `DATABASE_URL` and ensures that the hostname resolves to one of the approved local loopback identifiers:
- `localhost`
- `127.0.0.1`
- `::1`
- `postgres` (Docker container network name)
- `db`
- `host.docker.internal`

If `DATABASE_URL` points to a hosted remote database (such as Supabase, AWS RDS, Neon, or Railway), the script refuses to run to protect against catastrophic data overwrites.

### Diagnostic Commands

Check which database host your current environment is targeting:
```bash
node -e "const u = new URL(process.env.DATABASE_URL || ''); console.log('Resolved target host:', u.hostname);"
```

### Resolution

1. If you intended to seed your local Docker database, update `web/.env.local`:
   ```ini
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/talos
   DIRECT_URL=postgresql://postgres:postgres@localhost:5432/talos
   ```

2. If you are deliberately seeding a designated remote preview or staging database (never production):
   ```bash
   ALLOW_UNSAFE_DB_SEED=true pnpm --dir web run db:seed
   ```

---

## Scenario 4: Seed Guard Rejection in Production Mode or Missing DATABASE_URL

### Symptoms
When executing `pnpm --dir web run db:seed`:

If `NODE_ENV=production`:
```text
Error: Refusing to seed a production process. Set ALLOW_UNSAFE_DB_SEED=true only for an intentional, reviewed override.
    at Module.assertSafeSeedDatabaseUrl (file:///.../web/src/db/seed-guard.ts:29:11)
```

If `DATABASE_URL` is empty or not set:
```text
Error: Refusing to seed: DATABASE_URL is not set. Point it at the local development database.
    at Module.assertSafeSeedDatabaseUrl (file:///.../web/src/db/seed-guard.ts:21:11)
```

If `DATABASE_URL` is not a valid PostgreSQL protocol:
```text
Error: Refusing to seed: DATABASE_URL must use a PostgreSQL protocol and point at a local development database.
    at Module.assertSafeSeedDatabaseUrl (file:///.../web/src/db/seed-guard.ts:44:11)
```

### Cause
`seed-guard.ts` verifies that:
1. `DATABASE_URL` is defined and parses as a valid URL.
2. The URL protocol begins with `postgres` or `postgresql`.
3. The process is not executing under `NODE_ENV=production`.

### Diagnostic Commands

Check the values of `NODE_ENV` and `DATABASE_URL` in your shell:
```bash
echo "NODE_ENV=$NODE_ENV"
echo "DATABASE_URL=$DATABASE_URL"
```

### Resolution

1. Reset `NODE_ENV` to development:
   ```bash
   export NODE_ENV=development
   ```

2. Export the local stack database connection string:
   ```bash
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/talos"
   export DIRECT_URL="postgresql://postgres:postgres@localhost:5432/talos"
   ```

3. Re-run seeding:
   ```bash
   pnpm --dir web run db:seed
   ```

---

## Scenario 5: Migration Drift: Orphan SQL Files and Numeric Prefix Collisions

### Symptoms
When running `pnpm migrations:check` or `pnpm migrations:check:strict` (or during CI check `check-migration-drift.mjs`):

```text
Migration drift gate — .../web/drizzle
journal entries: 20 | sql files: 32 | orphans: 12 | prefix collisions: 6
error: orphan migration SQL not in journal (12): 0010_retired_agent_preservation.sql, 0012_add_audit_log_enhancements.sql, ...
error: ambiguous numeric migration prefixes:
  - 0010: 0010_add_token_purchases.sql, 0010_retired_agent_preservation.sql
  - 0013: 0013_add_backup_runs.sql, 0013_add_dividend_idempotency.sql, 0013_add_quota_tables.sql, ...
✗ migration drift detected. Fix journal/SQL consistency before merge.
Local command: pnpm migrations:check
Strict mode:   pnpm migrations:check:strict
```

Or when a journal entry tag does not have a matching SQL file:

```text
error: journal tags missing SQL files: 0021_example.sql (fail closed)
```

### Cause
[`scripts/check-migration-drift.mjs`](../scripts/check-migration-drift.mjs) enforces consistency between `web/drizzle/meta/_journal.json` and the migration SQL files in `web/drizzle/`:
1. Every migration tag registered in `_journal.json` must have a corresponding `.sql` file.
2. Entry `idx` properties must be contiguous integers starting from `0`.
3. In strict mode (`--strict`), every `.sql` file must be registered in the journal (no orphan migrations).
4. No two migration files may share the same 4-digit prefix (e.g. `0013_a.sql` and `0013_b.sql`).

Collisions typically happen when two parallel branches independently create a new migration.

### Diagnostic Commands

Run the drift check offline (does not require Postgres or `drizzle-kit`):
```bash
# Structural check (journal ↔ SQL)
pnpm migrations:check

# Strict check (fails on orphan files and prefix collisions)
pnpm migrations:check:strict

# Run the drift test suite
pnpm test:migration-drift
```

### Resolution

1. If schema changes were made in [`web/src/db/schema.ts`](../web/src/db/schema.ts) without generating a migration:
   ```bash
   pnpm --dir web db:generate
   ```
   This ensures Drizzle Kit updates `web/drizzle/meta/_journal.json` and creates the SQL file together.

2. If two branches created colliding numeric prefixes (e.g., both added `0013_*.sql`):
   - Determine the highest current contiguous index in `web/drizzle/meta/_journal.json`.
   - Rename your new migration file to the next available number (e.g. `0021_your_migration.sql`).
   - Update `web/drizzle/meta/_journal.json` to reflect the updated `idx` and `tag`.

3. Re-verify:
   ```bash
   pnpm migrations:check:strict
   ```

See [`MIGRATIONS.md`](../MIGRATIONS.md) for full migration workflows.

---

## Scenario 6: Missing RLS Role Bootstrap on Local Postgres

### Symptoms
When applying migrations to a fresh local Postgres container or standalone PostgreSQL instance (`pnpm --dir web db:migrate`):

```text
error: role "anon" does not exist
```
or:
```text
error: role "authenticated" does not exist
```
or from the migration drift gate:
```text
error: missing bootstrap-roles.sql (required before first migrate)
```

### Cause
Migrations `0001_enable_rls.sql` and `0002_rls_postgres_role.sql` grant Row Level Security (RLS) privileges to Supabase roles (`anon`, `authenticated`). Supabase provisions these roles automatically, but standard PostgreSQL does not.

The file [`web/drizzle/bootstrap-roles.sql`](../web/drizzle/bootstrap-roles.sql) must be executed once against any clean PostgreSQL database before running `db:migrate`.

### Diagnostic Commands

Check if roles exist in the PostgreSQL instance:
```bash
docker compose exec postgres psql -U postgres -d talos -c "\du"
```

### Resolution

Execute the bootstrap SQL file against the target database:

Using `docker compose`:
```bash
docker compose exec -T postgres psql -U postgres -d talos < web/drizzle/bootstrap-roles.sql
```

Using local `psql`:
```bash
psql "postgresql://postgres:postgres@localhost:5432/talos" -f web/drizzle/bootstrap-roles.sql
```

Then run the migrations:
```bash
pnpm --dir web db:migrate
```

---

## Scenario 7: Safe Test-Data Reset Refusals (`stack:reset-data` and `db:reset-test-data`)

### Symptoms
When attempting to clear local test data via `pnpm stack:reset-data` or `pnpm --dir web run db:reset-test-data`:

1. **Missing confirmation**:
   ```text
   db:reset-test-data: Refusing to delete local test data without --yes (or use --dry-run to preview).
   Run with --help for usage.
   ```

2. **Unmigrated or partially migrated database**:
   ```text
   db:reset-test-data: No Talos tables found in this database. Run `pnpm --dir web run db:migrate` first.
   ```
   or:
   ```text
   db:reset-test-data: Database is missing modelled tables: tls_talos, tls_patrons, ... Run `pnpm --dir web run db:migrate` first.
   ```

3. **Non-local host**:
   ```text
   db:reset-test-data: Refusing to reset database "talos" on non-local host "db.remote.com". This command only targets localhost, 127.0.0.0/8, or ::1.
   ```

### Cause
[`web/src/lib/local-test-data-reset.ts`](../web/src/lib/local-test-data-reset.ts) implements an intentionally fail-closed security contract:
- Only loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) are allowed. There is deliberately no override flag.
- Destructive truncation requires `--yes`.
- Every table modelled in `web/src/db/schema.ts` must exist in the database; missing tables indicate an unmigrated database where reset would silently do nothing useful.
- Hosted markers (`NODE_ENV=production`, `VERCEL_ENV`, `RAILWAY_ENVIRONMENT`) refuse execution immediately.

### Diagnostic Commands

Preview the reset plan and view current row counts without changing anything:
```bash
pnpm stack:reset-data --dry-run
# Or directly:
pnpm --dir web run db:reset-test-data --dry-run
```

### Resolution

1. If the database is missing modelled tables, run migrations first:
   ```bash
   pnpm --dir web db:migrate
   ```

2. Perform the reset with explicit confirmation:
   ```bash
   pnpm stack:reset-data --yes
   ```

3. Reset and repopulate with canonical seed data in one step:
   ```bash
   pnpm stack:reset-data --yes --seed
   ```

See [`docs/local-test-data-reset.md`](./local-test-data-reset.md) for full documentation.

---

## Scenario 8: Postgres Service Not Running During Reset

### Symptoms
Running `pnpm stack:reset-data` returns:

```text
local-stack: the postgres service is not running.
Start it first with: pnpm stack:up
Use 'pnpm stack:reset' only if you want to destroy and recreate the stack volumes.
```

### Cause
[`scripts/local-stack.sh`](../scripts/local-stack.sh) checks `docker compose ps -q postgres` before invoking the Node reset tool. If the Postgres container is stopped, paused, or exited, it aborts immediately to avoid connection timeouts or misleading errors.

### Diagnostic Commands

Check the container status:
```bash
docker compose ps postgres
```

### Resolution

1. Start the stack services:
   ```bash
   pnpm stack:up
   ```

2. Wait for the healthy status:
   ```bash
   docker compose ps postgres
   ```

3. Re-run data reset:
   ```bash
   pnpm stack:reset-data --yes --seed
   ```

---

## Scenario 9: Missing or Incomplete Environment Configuration

### Symptoms
Running setup checks (`bash scripts/setup.sh` or `scripts\setup.bat`):

```text
🚀 Talos Protocol — Setup Verification
========================================

📋 Checking Environment Variables...
------------------------------------
❌ Missing: DATABASE_URL
❌ Missing: DIRECT_URL
❌ Missing: STELLAR_NETWORK
❌ Missing: STELLAR_HORIZON_URL
...
========================================
Passed: 0
Warnings: 1
Failed: 13

⚠️  Please fix the issues above before deploying
```

Or during local Next.js startup:
```text
Error: DATABASE_URL is not set. Point it at the local development database.
```

### Cause
Fresh checkouts do not contain `.env.local` files because credentials and environment-specific settings are excluded from version control.

### Diagnostic Commands

Verify environment variables across packages:
```bash
# POSIX
bash scripts/setup.sh

# Windows
scripts\setup.bat
```

### Resolution

1. Copy verified example templates:
   ```bash
   cp web/.env.example web/.env.local
   cp packages/prime-agent/.env.example packages/prime-agent/.env
   cp contracts/.env.example contracts/.env
   ```

2. For local stack development with Docker Compose, verify that `web/.env.local` matches the local stack service addresses:
   ```ini
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/talos
   DIRECT_URL=postgresql://postgres:postgres@localhost:5432/talos
   STELLAR_NETWORK=testnet
   STELLAR_HORIZON_URL=http://localhost:4010
   STELLAR_RPC_URL=http://localhost:4010
   NEXT_PUBLIC_STELLAR_NETWORK=testnet
   NEXT_PUBLIC_STELLAR_RPC_URL=http://localhost:4010
   NEXT_PUBLIC_STELLAR_WALLET_NETWORK=testnet
   ```

3. Verify readiness endpoint:
   ```bash
   curl http://localhost:3000/api/health
   ```

---

## Scenario 10: Mock Stellar Unreachable or Fault Injection Active

### Symptoms
Local API requests to Stellar Horizon or Soroban RPC fail with connection errors:

```text
FetchError: request to http://localhost:4010/health failed, reason: connect ECONNREFUSED 127.0.0.1:4010
```

Or responses from `http://localhost:4010` intermittently return 500 errors, experience long delays, or drop connections. The container logs show:

```text
[FAULT_INJECTION] LATENCY: {"endpoint":"health","delayMs":1000}
[FAULT_INJECTION] ERROR: {"endpoint":"accounts","rate":0.5}
[FAULT_INJECTION] TIMEOUT: {"endpoint":"transactions","rate":0.2}
[FAULT_INJECTION] MALFORMED: {"endpoint":"fee_stats","rate":0.1}
```

### Cause
[`scripts/mock-stellar-server.mjs`](../scripts/mock-stellar-server.mjs) runs inside `talos-mock-stellar` and simulates Horizon and Soroban RPC endpoints on port 4010.
- If the container is stopped or unhealthy, requests will fail with `ECONNREFUSED`.
- If fault injection variables (`FAULT_INJECTION_ENABLED=true`) were enabled during test runs, simulated latencies, timeouts, and errors will be injected into requests.

### Diagnostic Commands

1. Query the mock Stellar health endpoint:
   ```bash
   curl -i http://localhost:4010/health
   ```
   Expected normal response:
   ```json
   {"ok":true,"service":"mock-stellar"}
   ```

2. Inspect container status and fault logs:
   ```bash
   docker compose ps mock-stellar
   docker compose logs mock-stellar
   ```

3. Run the mock Stellar fault suite to verify behavior:
   ```bash
   pnpm test:mock-stellar-faults
   ```

### Resolution

1. If mock-stellar container is down:
   ```bash
   docker compose up -d mock-stellar
   ```

2. If fault injection was enabled, disable it in your shell environment or `.env`:
   ```bash
   export FAULT_INJECTION_ENABLED=false
   export FAULT_LATENCY_MS=0
   export FAULT_ERROR_RATE=0
   export FAULT_TIMEOUT_RATE=0
   export FAULT_MALFORMED_RATE=0

   docker compose up -d mock-stellar
   ```

See [`docs/mock-stellar-fault-injection.md`](./mock-stellar-fault-injection.md) for full configuration details.

---

## Scenario 11: Toolchain Version Discrepancies and Missing Prerequisites

### Symptoms
Running `pnpm doctor` exits with code 1 and reports toolchain errors:

```text
Talos local toolchain doctor
✓ Node.js 24.14.1
✓ pnpm 10.33.2
✗ Python 3.10.0 is too old; 3.11.0 or newer is required. Install Python 3.11 or newer from https://www.python.org/downloads/.
✗ uv not found. Install uv using the instructions at https://docs.astral.sh/uv/getting-started/installation/.
✓ Rust compiler 1.98.1
✓ Cargo 1.98.1
✗ wasm32-unknown-unknown is not installed. Run `rustup target add wasm32-unknown-unknown`.
✗ Docker not found. Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/.
! not installed (optional). Optional: install the Stellar CLI with `cargo install --locked stellar-cli --features opt`.
```

### Cause
[`scripts/doctor.mjs`](../scripts/doctor.mjs) validates all local tool dependencies against monorepo minimum versions:
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Python >= 3.11.0
- `uv` package manager
- Rust compiler and `cargo`
- Rust target `wasm32-unknown-unknown` (for Soroban smart contracts in `contracts/`)
- Docker (for the local stack)
- Stellar CLI (optional)

### Diagnostic Commands

Run doctor check:
```bash
pnpm doctor
# Or run test suite:
pnpm doctor:test
```

### Resolution

1. **Python**: Upgrade to Python 3.11+ from https://www.python.org/downloads/.
2. **`uv`**: Install `uv` via official Astral installer:
   - Linux/macOS: `curl -LsSf https://astral.sh/uv/install.sh | sh`
   - Windows PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
3. **Rust Wasm Target**:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```
4. **Node & pnpm**:
   ```bash
   corepack enable
   corepack prepare pnpm@9 --activate
   ```
5. **Docker**: Ensure Docker Desktop or Docker Engine is installed and running (`docker info`).

---

## Verifying Stack Health

Once issues are resolved, confirm that all stack components are operational:

```bash
# 1. Run doctor checks
pnpm doctor

# 2. Check migration drift
pnpm migrations:check

# 3. Start stack
pnpm stack:up

# 4. Check container status
docker compose ps

# 5. Verify health endpoints
curl http://localhost:4010/health       # Mock Stellar
curl http://localhost:3000/api/health   # Web Application

# 6. View logs
pnpm stack:logs
```

---

## Related Documentation

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — Main contribution and development guide.
- [`MIGRATIONS.md`](../MIGRATIONS.md) — Database migrations and schema guide.
- [`docs/local-test-data-reset.md`](./local-test-data-reset.md) — Safe local test-data reset specification.
- [`docs/mock-stellar-fault-injection.md`](./mock-stellar-fault-injection.md) — Mock Stellar fault injection guide.
- [`docker-compose.yml`](../docker-compose.yml) — Container stack definition.
- [`scripts/local-stack.sh`](../scripts/local-stack.sh) / [`scripts/local-stack.bat`](../scripts/local-stack.bat) — Stack orchestration scripts.
- [`web/src/db/seed-guard.ts`](../web/src/db/seed-guard.ts) — Seed guard implementation.
