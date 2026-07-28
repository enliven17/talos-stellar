# Background Jobs

A durable, Postgres-backed job queue for slow or retryable work on the web
boundary — no new infrastructure (no Redis/broker), just the same
`DATABASE_URL` the rest of the app already uses.

## Why Postgres and not a broker

The web app is deployed as Next.js on Vercel: serverless functions, no
persistent process, multiple instances. A queue that lives in the same
Postgres database avoids a new moving part and gets transactional
consistency with the rows the jobs act on for free. Concurrency safety
comes from `SELECT ... FOR UPDATE SKIP LOCKED`: multiple instances (or the
drain endpoint firing on an overlapping schedule) can lease from the same
table without double-processing a row.

## Status lifecycle

```
pending → leased → completed
                 ↘ pending    (transient failure — runAt pushed out by backoff)
                 ↘ dead_letter (retries exhausted, or a "fatal" retryClass)
pending|leased → cancelled   (cooperative — see Cancellation below)
```

- **pending** — eligible for leasing once `runAt <= now()`.
- **leased** — a worker holds it; `leaseId`/`leaseExpiresAt` identify the claim.
- **completed** — terminal, success. `result` holds the handler's return value.
- **dead_letter** — terminal, failure. `lastError` holds the last (truncated) error message.
- **cancelled** — terminal, cooperative cancellation.

## Leasing, heartbeats, and crash recovery

`leaseBatch()` (`src/lib/jobs/store.ts`) atomically claims up to
`JOBS_BATCH_SIZE` due jobs with `UPDATE ... WHERE id IN (SELECT ... FOR
UPDATE SKIP LOCKED)`. A lease has an expiry (`JOBS_LEASE_DURATION_MS`); a
running handler extends it by calling `ctx.heartbeat()`, which also reports
back whether cancellation was requested.

If a worker process dies mid-job (crash, OOM, deploy), it simply stops
heartbeating and the lease expires. There is no separate crash-recovery
path — every `runOnce()` call starts by reaping expired leases
(`reapExpiredLeases()`): jobs with attempts remaining go back to `pending`,
jobs that already exhausted their budget go straight to `dead_letter`. This
is what makes leasing safe to run from multiple instances with no
coordinator.

## Retry classes

Set per job at enqueue time (`retryClass`, default `transient`). Backoff is
full-jitter exponential (`src/lib/jobs/retry.ts`):

| Class | Use for | Base | Cap |
|---|---|---|---|
| `transient` | network blips, timeouts, transient DB errors | 1s | 5 min |
| `rate_limited` | upstream 429 / throttling | 10s | 15 min |
| `fatal` | bad input, auth failure — won't resolve on retry | — | dead-letters on the first failure |

`maxAttempts` (default `JOBS_DEFAULT_MAX_ATTEMPTS`, 8) is the ceiling for
`transient`/`rate_limited`; `fatal` ignores it and always dead-letters
immediately.

## Cancellation

Cancellation is cooperative, not preemptive — there's no way to kill a
running handler mid-execution, so a leased job's `cancelRequested` flag is
only observed the next time the handler calls `ctx.heartbeat()` (or checks
`ctx.signal`). Write handlers that heartbeat periodically during any
long-running loop. A `pending` job is cancelled immediately since nothing
is running yet.

## Idempotency

`enqueue(queue, payload, { idempotencyKey })` is a no-op (returns the
existing row) on a repeat call with the same `(queue, idempotencyKey)` —
enforced by a partial unique index. Use this on any enqueue call reachable
from an at-least-once delivery path (e.g. a webhook retry) to avoid
duplicate work.

## Configuration

All read from the environment at process start (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `JOBS_ENABLED` | `false` | Master switch. See Rollout below. |
| `ADMIN_API_KEY` | — | Bearer token for `/api/admin/jobs/*`. Required to use those routes. |
| `INTERNAL_JOBS_SECRET` | — | Shared secret for `/api/internal/jobs/drain`. Required to use it. |
| `JOBS_LEASE_DURATION_MS` | `30000` | How long a lease is held before it's reapable. |
| `JOBS_HEARTBEAT_INTERVAL_MS` | `10000` | How often a running handler heartbeats. |
| `JOBS_BATCH_SIZE` | `10` | Jobs claimed per `runOnce()` call. |
| `JOBS_DEFAULT_MAX_ATTEMPTS` | `8` | Default ceiling for jobs that don't specify one. |
| `JOBS_POLL_INTERVAL_MS` | `2000` | Continuous-worker poll interval when the queue is empty. |
| `JOBS_SHUTDOWN_GRACE_MS` | `10000` | Grace period for in-flight jobs during graceful shutdown. |

## Running it

Two ways to drain the queue, pick based on deployment target:

**Serverless (Vercel)** — `POST /api/internal/jobs/drain` leases and
processes one bounded batch, then returns; it's designed to fit inside a
function's execution budget. Point an external scheduler at it (Vercel
Cron, a GitHub Actions schedule, or the same Railway project already
running `packages/prime-agent`) with header `X-Internal-Jobs-Secret:
<INTERNAL_JOBS_SECRET>`, on an interval close to `JOBS_POLL_INTERVAL_MS`.

**Long-lived process (Railway, etc.)** — `pnpm jobs:worker`
(`scripts/jobs-worker.ts`) runs the same `runOnce()` batch in a continuous
loop. Handles `SIGTERM`/`SIGINT`: stops leasing new batches and signals
in-flight handlers to abort cooperatively (`ctx.signal`), then waits up to
`JOBS_SHUTDOWN_GRACE_MS` for the batch to finish. Anything still running
when the grace period elapses has its lease released back to `pending`
immediately (`release()` in `store.ts`) rather than waiting out the full
`JOBS_LEASE_DURATION_MS` — the process then exits, and another worker (or
this one, after restart) picks the job back up right away.

Either way, nothing drains the queue while `JOBS_ENABLED=false` — the drain
route responds `{ enabled: false, summary: null }` and the worker script
polls without leasing. It's always safe to wire up the scheduler/service
before flipping the flag.

## Admin inspection

All under `Authorization: Bearer <ADMIN_API_KEY>`:

- `GET /api/admin/jobs?status=&queue=&cursor=&limit=` — list, cursor-paginated by `createdAt` descending (same convention as the rest of the API — see `OBSERVABILITY.md`).
- `GET /api/admin/jobs/:id` — full record, including `payload` and `result`, for debugging a stuck or dead-lettered job.
- `POST /api/admin/jobs/:id/retry` — requeue a `dead_letter`/`cancelled` job (resets attempts, clears `lastError`). 409 if the job isn't in one of those states.
- `POST /api/admin/jobs/:id/cancel` — cooperative cancel. 409 if the job is already in a terminal state.

## Observability

Every state transition is a structured `pino` log line via `src/lib/jobs/metrics.ts`
(`job_enqueued`, `job_leased`, `job_heartbeat`, `job_completed`,
`job_retry_scheduled`, `job_dead_letter`, `job_cancelled`,
`job_lease_reaped`) with `jobId`, `queue`, `attempts`, `durationMs`, etc.
**Never** `payload`, `result`, or a raw error object — `lastError` on the
row (and in logs) is `truncateError()`'d down to the error's `message`
only, capped at 500 characters, no stack, no cause chain. If a job's
payload might itself carry something sensitive, that's a property of the
specific handler/queue, not the framework — keep secrets out of job
payloads the same way you'd keep them out of any other DB row a
Bearer-token-gated endpoint (`/api/admin/jobs/:id`) can return.

To watch queue health: correlate `job_dead_letter` volume by `queue`, and
`job_lease_reaped` (a worker died without heartbeating — expected
occasionally on deploys, a signal of a stuck/crashing handler if frequent).

## Adding a new job type

1. Create `src/lib/jobs/handlers/<name>.ts`, call `registerHandler(queueName, handler)` at module scope.
2. Add the import to `src/lib/jobs/handlers/index.ts`.
3. Call `enqueue(queueName, payload, opts)` from wherever the work originates. `enqueue` alone doesn't need the handler registry — only the drain route and `scripts/jobs-worker.ts` (which actually execute jobs) import `handlers/index.ts`.

## Migration / rollback

- **Forward migration**: `drizzle/0012_add_background_jobs.sql` — additive only, one new table (`tls_jobs`), no changes to existing tables. `pnpm db:migrate` applies it; safe to run against a live database with no downtime.
- **Rollback**: `JOBS_ENABLED=false` (or unset) immediately stops all new enqueue/processing behavior — everything currently integrated (the audit-log write in `src/lib/auth.ts`) reverts to its pre-existing direct-write behavior with no code change. The `tls_jobs` table can be left in place (inert) or dropped (`DROP TABLE tls_jobs;`) independently, since nothing else references it via a foreign key.
- **Compatibility**: the table is new, so there's no existing-data migration to reason about. The one integrated call site (audit-log write) is behind the same flag, so its behavior is unchanged unless an operator opts in.

## Known limitations

- Cancellation is cooperative and bounded by `JOBS_HEARTBEAT_INTERVAL_MS` — a handler that never heartbeats won't observe a cancel request until it returns.
- No priority preemption: `priority` only affects lease order among currently-pending jobs, not currently-leased ones.
- No cron/recurring-schedule primitive — `enqueue()` with `delayMs` covers one-shot delays; a recurring job must re-enqueue itself from its own handler.
- The serverless drain endpoint depends on an external scheduler actually calling it — there's no built-in Vercel Cron config in this repo yet (Vercel Cron requires a paid plan tier for sub-daily schedules); wire one up per-deployment.

## Local verification

```bash
# 1. Apply the migration
pnpm db:migrate

# 2. Enable the framework
export JOBS_ENABLED=true
export ADMIN_API_KEY=dev-admin-key
export INTERNAL_JOBS_SECRET=dev-internal-secret

# 3a. Serverless-style: run the app, then trigger a drain manually
pnpm dev
curl -X POST http://localhost:3000/api/internal/jobs/drain \
  -H "X-Internal-Jobs-Secret: dev-internal-secret"

# 3b. Or run the continuous worker instead of manual drains
pnpm jobs:worker   # Ctrl+C to see graceful shutdown in the logs

# 4. Trigger a real job: any authenticated agent request enqueues an
#    audit-log write (e.g. GET /api/talos/:id/wallet with a valid API key)

# 5. Inspect it
curl -H "Authorization: Bearer dev-admin-key" \
  "http://localhost:3000/api/admin/jobs?queue=audit_log_write"
```

Automated coverage: `pnpm test:unit` runs the framework's unit tests
(`tests/jobs-*.unit.test.ts` — retry math, store operations against a
mocked DB, the runner's success/retry/dead-letter/cancel branches, admin
route auth and responses, the drain endpoint). `pnpm test:e2e` includes
`tests/jobs-e2e.test.ts`, which runs the real enqueue → lease → complete
round trip against a live server and Postgres when `ADMIN_API_KEY` /
`INTERNAL_JOBS_SECRET` are configured (CI sets both — see
`.github/workflows/deploy.yml`); otherwise that suite's round-trip case
skips rather than failing, since unconfigured is the expected default for
a contributor who hasn't opted in.
