# Load & Soak Testing

This directory (`web/tests/load/`) contains load and resilience tests that
exercise the app under real, concurrent traffic against a running dev
server — distinct from the unit/integration tests in `web/tests/`, which
run in isolation with mocked dependencies.

## What's covered

- **`liveness.test.ts`** — confirms the read-rate-limit policy (100
  requests/60s per IP, `RATE_LIMIT_READ_LIMIT`) is enforced correctly
  under real concurrent load against `/api/health/live`, with zero
  unexpected failures.
- **`sse-saturation.test.ts`** — opens a burst of concurrent SSE
  connections against `/api/events` and confirms every attempt is
  accounted for (accepted, rate-limited, or pool-rejected — never
  silently dropped or left hanging).
  - **Known limitation:** because the read rate limit (100/60s) is lower
    than the SSE connection pool cap (`SSE_MAX_CONNECTIONS`, default
    200), a single burst within one rate-limit window exhausts the rate
    limiter before ever reaching the pool cap. `poolRejected` will
    typically be `0` in a single run. Exercising the pool cap itself
    would require spreading connection attempts across multiple
    rate-limit windows — left as a follow-up.
- **`dependency-failure.test.ts`** — confirms `/api/health` responds
  within its documented timeout bound (`DB_TIMEOUT_MS` +
  `STELLAR_TIMEOUT_MS`, see `src/app/api/health/utils.ts`) rather than
  hanging when a dependency is slow or unreachable, and that its
  response shape stays trustworthy either way.

## Setup

1. A running dev server: `pnpm dev` (in a separate terminal — these
   tests make real HTTP requests to `localhost:3000`).
2. A real Postgres connection in `.env.local` (`DATABASE_URL`) — needed
   for `dependency-failure.test.ts` and for `/api/events`'s wallet
   lookup in `sse-saturation.test.ts`. Any reachable Postgres instance
   works (Supabase free tier is sufficient); no specific schema state is
   required for the tests in this directory.

## Running

```bash
pnpm test:load
```

Runs everything under `tests/load/`. Not included in `pnpm test:unit` or
`pnpm test:e2e` — these tests need a live server and real network
traffic, so they're opt-in and excluded from default CI.

## Interpreting a failure

- **`otherFailures > 0`** — something genuinely broke (not rate-limited,
  not pool-rejected, not a clean success). Check the dev server's
  terminal for the actual error.
- **`stillPending > 0`** (SSE test) — a connection attempt never
  resolved within the settle window. Usually means the dev server
  process died mid-test — restart `pnpm dev` and rerun.
- **Timeout-bound failure** (`dependency-failure.test.ts`) — the health
  check took longer than its documented timeout. This means a
  dependency's `withTimeout()` wrapper (`src/app/api/health/utils.ts`)
  isn't actually bounding the call — worth checking whether the
  dependency's own client honors `AbortSignal` cancellation.

## Rollback

These are test files only — no schema changes, no production code
touched, no migrations. To remove: delete `web/tests/load/`, remove the
`test:load` script from `package.json`, delete this file. No state to
repair.

## Known upstream issues encountered during this work (not fixed here,
## out of scope for this PR)

- `src/db/relations.ts` references `tlsWebhookSubscriptions` and
  `tlsWebhookDeliveries`, neither of which is defined in `src/db/schema.ts`
  — breaks the app on a fresh `main` checkout until patched locally.
- `src/middleware.ts` and `src/proxy.ts` both exist and conflict (Next.js
  refuses to start with both present) — `proxy.ts` is the newer
  convention and should likely be the one kept.
- The Drizzle migration chain has multiple files independently adding
  the same `txHash` column to `tls_commerce_jobs`
  (`0000`, `0003`, `0005`, `0009`, `0010`, `0013_add_stellar_tx_records.sql`,
  `0015`) — `pnpm db:migrate` fails on a fresh database with a duplicate
  column error.