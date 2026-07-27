# Transactional Outbox

A durable, Postgres-backed outbox for domain events, so a database mutation
and the event describing it can never diverge — no broker, same
`DATABASE_URL` the rest of the app already uses. Same leasing technique as
`web/JOBS.md` (`SELECT ... FOR UPDATE SKIP LOCKED`), so it's safe across
multiple app instances with no coordinator.

## Status lifecycle

```
pending → leased → dispatched
                 ↘ pending      (retry — runAt pushed out by backoff)
                 ↘ dead_letter  (retries exhausted, or no consumer registered)
```

## Atomic write

`writeOutboxEvent(tx, input)` takes the *same* `tx` your domain mutation is
already using inside `db.transaction(async (tx) => { ... })`. The event
insert commits or rolls back together with the mutation — there's no window
where one happened without the other.

```ts
await db.transaction(async (tx) => {
  const [job] = await tx.update(tlsCommerceJobs)...returning();
  await writeOutboxEvent(tx, {
    aggregateType: "commerce_job",
    aggregateId: job.id,
    eventType: "commerce_job.completed",
    payload: { ... },
    dedupeKey: job.id, // optional — see Deduplication
  });
});
```

## Dispatch

`dispatchOnce()` (`src/lib/outbox/dispatcher.ts`) leases a bounded batch,
runs every consumer registered for each event's `eventType`
(`registerConsumer`, `src/lib/outbox/registry.ts`), and acks or retries the
event as a whole. **All consumers for an event type re-run on retry** — an
event type has no per-consumer cursor, so consumers must be idempotent. An
event type with zero registered consumers dead-letters immediately.

Two ways to drive it, same trade-off as the jobs framework:
- **Serverless**: `POST /api/internal/outbox/drain`, header
  `X-Outbox-Dispatch-Secret: <OUTBOX_DISPATCH_SECRET>`. Point a scheduler
  (Vercel Cron, Railway) at it.
- **Long-lived process**: `pnpm outbox:worker`
  (`scripts/outbox-worker.ts`), continuous loop, SIGTERM/SIGINT stop
  leasing new batches. Dispatch is expected to be fast (in-process consumer
  calls, not long-running jobs), so unlike the jobs worker there's no
  heartbeat/release step — anything still in flight at exit just hits its
  short lease expiry (`OUTBOX_LEASE_DURATION_MS`, default 15s) and gets
  reaped by the next dispatcher.

Crash recovery: every `dispatchOnce()` call reaps expired leases first
(`reapExpiredLeases()`) — jobs with attempts left go back to `pending`,
exhausted ones go to `dead_letter`. No separate recovery path.

## Retry & deduplication

One retry class: full-jitter exponential backoff, 1s base, 5 min cap
(`src/lib/outbox/retry.ts`), up to `maxAttempts` (default
`OUTBOX_DEFAULT_MAX_ATTEMPTS`, 8), then `dead_letter`.

`dedupeKey` (scoped per `eventType`, partial unique index) makes
`writeOutboxEvent` a no-op on a repeat call with the same key — use it
whenever the surrounding code path can run more than once for the same
logical mutation (e.g. a route already guarded by its own idempotency key).

## Retention

`pruneDispatched()` runs on every `dispatchOnce()` call and deletes
`dispatched` rows older than `OUTBOX_RETENTION_DAYS` (default 7).
`dead_letter` rows are never auto-pruned — they need operator attention via
`/api/admin/outbox`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OUTBOX_ENABLED` | `false` | Master switch. |
| `ADMIN_API_KEY` | — | Bearer token for `/api/admin/outbox/*`. |
| `OUTBOX_DISPATCH_SECRET` | — | Header secret for `/api/internal/outbox/drain`. |
| `OUTBOX_LEASE_DURATION_MS` | `15000` | Lease window before a claim is reapable. |
| `OUTBOX_BATCH_SIZE` | `25` | Events claimed per `dispatchOnce()`. |
| `OUTBOX_DEFAULT_MAX_ATTEMPTS` | `8` | Default retry ceiling. |
| `OUTBOX_POLL_INTERVAL_MS` | `2000` | Worker poll interval when idle. |
| `OUTBOX_RETENTION_DAYS` | `7` | How long dispatched rows are kept. |

## Admin inspection

Under `Authorization: Bearer <ADMIN_API_KEY>`:
- `GET /api/admin/outbox?status=&eventType=&cursor=&limit=` — cursor-paginated list.
- `GET /api/admin/outbox/:id` — full record.
- `POST /api/admin/outbox/:id/retry` — requeue a `dead_letter` event. 409 otherwise.

## Observability

Structured `pino` logs per transition (`outbox_event_written`,
`_leased`, `_dispatched`, `_retry_scheduled`, `_dead_letter`,
`outbox_lease_reaped`, `outbox_events_pruned`) — identifiers and counters
only, never `payload` or a raw error (see `src/lib/outbox/metrics.ts`;
same rationale as `web/JOBS.md`).

## Rollout / migration / rollback

- **Migration**: `drizzle/0012_add_outbox_events.sql` — additive only, one new table, no existing-table changes. Safe to apply live.
- **Default**: `OUTBOX_ENABLED=false`. The one integrated call site (`POST /api/jobs/:id/result`, `src/app/api/jobs/[id]/result/route.ts`) writes nothing extra when disabled — zero behavior change.
- **Rollback**: flip `OUTBOX_ENABLED` back to `false`. `tls_outbox_events` can stay in place (inert, nothing references it via FK) or be dropped independently.

## Known limitations

- No per-consumer delivery tracking — an event type's consumers all re-run together on retry.
- No priority/ordering guarantee across different aggregates; within one lease batch, order is `runAt` only.
- The serverless drain endpoint needs an external scheduler wired up per-deployment (no Vercel Cron config checked in yet).

## Local verification

```bash
pnpm db:migrate
export OUTBOX_ENABLED=true ADMIN_API_KEY=dev-admin-key OUTBOX_DISPATCH_SECRET=dev-dispatch-secret
pnpm dev
# ... complete an async commerce job via POST /api/jobs/:id/result ...
curl -X POST http://localhost:3000/api/internal/outbox/drain -H "X-Outbox-Dispatch-Secret: dev-dispatch-secret"
curl -H "Authorization: Bearer dev-admin-key" "http://localhost:3000/api/admin/outbox?eventType=commerce_job.completed"
```

`pnpm test:unit` covers retry math, store ops, dispatcher branches, and
admin/drain route auth (`tests/outbox-*.unit.test.ts`). `pnpm test:e2e`
includes `tests/outbox-e2e.test.ts`, a real write → lease → dispatch round
trip against a live server + Postgres when the env vars above are set in
CI (see `.github/workflows/deploy.yml`); otherwise it skips.
