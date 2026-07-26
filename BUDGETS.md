# A2A Budget Reservations & Usage Accounting (Issue #302)

## Overview

Adds durable, atomic financial state for autonomous commerce across
agents. Every reservation against a budget is a row in
`tls_budget_reservations` paired with an immutable event in
`tls_budget_usage_events`, and every transition is performed inside a
`withTransactionRetry` Postgres transaction so the budget mirror and
the audit trail stay aligned under concurrency or restart.

The reconciler is a snowflake-free pure function (`reconciliation.ts`)
that can be replayed from the ledger at any time, so a mirror drift
detected by an ops endpoint can be repaired in one round-trip without
ad-hoc SQL.

## Storage

Three new tables, additive. Pre-existing tables untouched.

| Table                      | Purpose                                                           |
|----------------------------|-------------------------------------------------------------------|
| `tls_budgets`              | Configuration: per-agent scope + limit, with rolling-window flag  |
| `tls_budget_reservations`  | Durable ledger of every reservation and its lifecycle             |
| `tls_budget_usage_events`  | Immutable event journal (kinds: reserve/commit/settle/refund/expire/release/reject) |

Amounts are stored as PostgreSQL `bigint` minor units (USDC ×10⁻⁶) and
round-trip through JS `BigInt`. The mirror `availableAmount` on
`tls_budgets` is authoritative for non-rolling scopes; rolling scopes
always recompute against the window so the mirror is allowed to be
stale.

Migration: `web/drizzle/0014_add_budget_reservations.sql`.

## Scope kinds

A single budget configuration covers exactly one scope per agent, keyed
by `(talosId, scopeKind, scopeValue)`. Scope kinds supported:

| Kind            | `scopeValue`          | Window | Example                                            |
|-----------------|-----------------------|--------|----------------------------------------------------|
| `global`        | `NULL`                | none   | total USDC spend allowed across the agent          |
| `rolling`       | `"daily"` / `"hourly"` | yes    | 24h or 1h spend window                             |
| `category`      | category name         | none   | per-category spend (e.g. "Sales")                  |
| `asset`         | asset code            | none   | per-asset spend (e.g. "USDC", "XLM")               |
| `transaction`   | service / job ID      | none   | one-off spend on a specific commerce transaction  |
| `counterparty`  | counterparty id       | none   | per-counterparty spend cap (e.g. one specific buyer) |

Scope refs (`counterpartyId`, `category`, `assetCode`) are also recorded
on each reservation to support accounting against category / asset /
counterparty scopes even when the parent budget is a global cap.

## Reservation lifecycle

```
                  ┌──────────┐
                  │ reserved │
                  └────┬─────┘
       commit ────────┼───────► released / expired / refunded
       settle ────────┤          (terminal — funds return to budget)
                       │
                  ┌──────────┐
                  │ committed│
                  └────┬─────┘
       settle ────────┼──────► released / refunded  (terminal)
                       │
                  ┌──────────┐
                  │  settled │
                  └────┬─────┘
                       │
                       └──────► refunded (terminal)
```

The state machine is enforced server-side by `VALID_TRANSITIONS`. The
caller supplies the current `fencingToken` (incremented at every
transition); stale writes are rejected with HTTP 409 (`stale_fencing_token`).

## Authorization

Every endpoint is gated by `verifyAgentApiKey` — the API key must match
the talos specified in the URL path. There is no implicit cross-agent
authorization; a budget on agent A cannot be touched by agent B even
if they share an API key.

Audit logs are not configured for budget endpoints: each transition already
emits a `tls_budget_usage_events` row that names the `talosId` and
`reservationId`, providing an audit trail by construction.

## Idempotency

A `(talosId, idempotencyKey)` partial unique index on
`tls_budget_reservations` (with `WHERE idempotencyKey IS NOT NULL`)
prevents concurrent duplicate reservations.

Two layers of defense:

1. **Pre-check**: `reserveBudget` reads the unique index first. If a
   row exists, it raises `idempotency_conflict` (HTTP 409) and skips
   lock acquisition.
2. **Race-safe insert**: if a concurrent request slips past the
   pre-check, the partial unique index raises Postgres 23505. The
   service catches this and maps it to the same `idempotency_conflict`
   error.

`Idempotency-Key` header carries the same value into the API; the
header is trimmed and an empty value is treated as absent (compat with
the commerce-jobs idempotency contract).

## Concurrency

`reserveBudget` and `transitionReservation` both:

- Acquire `SELECT … FOR UPDATE` on the matching `tls_budgets` row.
- Read live reservation+event ledger through the same transaction.
- Run inside `withTransactionRetry` with `category: "RESERVATION"` so
  40001/40P01/55P03 + transient connection failures are retried with
  jittered backoff.

Rolling scope reservation math is recomputed against the window each
time because `tls_budgets.availableAmount` is a mirror only. The mirror
update is skipped on rolling scopes intentionally.

A reservation whose `expiresAt` has elapsed is treated as expired
**without mutating state** (`classifyExpired`). The reconciler
excludes past-expiry 'reserved' rows from `used`. Operators can run a
sweep to migrate rows to `status='expired'` if desired; current
implementation treats both states equivalently for read paths.

## Reconciliation (pure function)

`computeBudgetAvailability({ budget, reservations, events, now })` is
the canonical truth and is used in three places:

1. `reserveBudget` — re-derive available before each reservation so
   concurrent reservations that haven't yet committed the mirror
   cannot race past the limit.
2. `reconcileBudget` — diff against `tls_budgets.availableAmount` and
   (when not dryRun and not rolling) repair drift.
3. `upsertBudget` — when a limit is changed, re-derive available with
   the new limit so committed reservations survive the change.

Math (deterministic, bigint-only):

```
used = Σ reservations.[amount]   where status ∈ {reserved, committed, settled}
                                    and (status ≠ reserved OR expiresAt > now)
                                    and (cutoff = null OR createdAt ≥ cutoff)
    + Σ events.[amount]          where kind = 'reserve' AND reservationId IS NULL
                                    and (cutoff = null OR createdAt ≥ cutoff)

available = max(0, limit − used)
```

Spend events (`commit` / `settle` / `release` / `refund` / `expire`)
are recorded for audit but never summed — the reservation's
encumbered status is the sole source of truth. This avoids double
counting when a reservation walks `reserved → committed → settled`.
The orphan-`reserve` rule is a defensive fallback if a reservation
row is ever lost.

## API surface (per agent, all under `/api/talos/:id/budgets`)

| Method | Path                          | Auth | Idempotency-key? | Description                                          |
|--------|-------------------------------|------|------------------|------------------------------------------------------|
| GET    | `/budgets`                    | ✓    | no               | List all budgets configured for the agent            |
| POST   | `/budgets`                    | ✓    | no               | Upsert a budget configuration                        |
| POST   | `/budgets/reserve`            | ✓    | yes              | Atomically reserve minor-units against a scope       |
| POST   | `/budgets/transition`         | ✓    | no               | Move a reservation to a new state (fencing token)    |
| POST   | `/budgets/reconcile`          | ✓    | no               | Diff against the mirror; repair when not dryRun       |

## Configuration

There are no environment variables — the system is fully data-driven:

| Knob                  | Where it lives                                | Effect                                       |
|-----------------------|-----------------------------------------------|----------------------------------------------|
| Scope kinds supported | `web/src/lib/schemas.ts` (`VALID_BUDGET_SCOPE_KINDS`) | New scope kinds must be added here + migration  |
| Reservation states    | `web/src/lib/schemas.ts` (`VALID_RESERVATION_STATES`)   | State machine lives in `reconciliation.ts`     |
| Default expiry        | `reserveBudgetSchema.expiresInSeconds` (default 3600)    | Reject if > 30 days                            |
| Max amountMinor       | regex `/^(?:0|[1-9][0-9]{0,18})$/` (≤ 9.2 × 10¹⁸)        | Prevents overflow                             |

The transaction-retry knobs (`DB_TRANSACTION_RETRY_*`) from
`db-retry.ts` apply as for any other write path.

## Observability

| Signal                                  | Where                                                  |
|-----------------------------------------|--------------------------------------------------------|
| Reservation created                     | `pino.info({ reservationId, talosId, budgetId, scopeKind, scopeValue, amountMinor, windowSeconds }, "budget_reservation_created")` |
| State transition                        | `pino.info({ reservationId, talosId, from, to, fencingToken }, "budget_reservation_transition")` |
| Drift detected & repaired               | `pino.warn({ budgetId, talosId, stored, computed }, "budget_reconciliation_repaired")` |
| Budget upsert                           | `pino.info({ talosId, budgetId, scopeKind }, "budget_upserted")` |
| Reconciliation result                   | `pino.info({ talosId, budgetId, mismatched, repaired }, "budget_reconcile_done")` |
| Reconciliation drift detected           | log only (no alert wired yet)                          |

Recommended Sentry alerts:

- `budget_reconciliation_repaired` more than once in 5 minutes → drift
  on a non-rolling scope suggests a code-level invariant violation.
- Repeated `idempotency_conflict` returns for a single agent →
  client retry storm or duplicate-call bug.

## Migration & rollback

**Forward migration** is `web/drizzle/0014_add_budget_reservations.sql`.
Apply with the existing migration runner; the migration is additive and
idempotent.

Rollback (manual, breaking — only for catastrophic recovery):

```sql
-- Drop the event journal first (preserves CASCADE chain).
DROP TABLE IF EXISTS "tls_budget_usage_events";
-- Drop the reservation ledger.
DROP TABLE IF EXISTS "tls_budget_reservations";
-- Drop the budget configuration.
DROP TABLE IF EXISTS "tls_budgets";
```

After rollback:
- All `/api/talos/:id/budgets*` routes return HTTP 500 from Drizzle
  "table not found" until the migration is re-applied. There is no
  backwards-compatibility shim once the route module is loaded because
  it imports the table symbols at module init.
- No pre-existing tables or data are modified.

Forward compatibility: all amounts are minor-units in bigint; future
fields (multi-currency per reservation, scheduled reservations,
settlement fees) can be added without breaking the existing API surface.

## Tests

- `web/tests/budget-reconciliation.unit.test.ts` — pure helper tests
  (no mocks): toBigInt coercion, computeBudgetAvailability across
  global / rolling / committed + settled / expired / orphan-event
  paths, classifyExpired, state machine, format/parse round-trips.
- `web/tests/budget-services.unit.test.ts` — service-layer tests with
  hoisted DB mocks: reserve happy/path/idempotency conflict
  (pre-check + 23505 race), insufficient_budget, transition fencing
  + state machine, release accounting, reconcile drift + repair +
  dryRun, upsert creation + limit-change preservation.
- `web/tests/budget-reservation.test.ts` — full HTTP-mock integration:
  reserve success, malformed body, auth, concurrent `Promise.all` with
  the same / different idempotency keys, transition state machine
  (forward and backwards), list + upsert.

## Limitations

1. **No per-transaction limits across categories**: a single
   reservation can encode one (scopeKind, scopeValue) tuple at a time.
   Multi-category caps require composing multiple reservations or
   extending the schema with an additional scope dimension.
2. **Released funds credit back only for non-rolling scopes**. Rolling
   scopes recompute on every read so the mirror is best-effort;
   historical usage outside the window is forgotten by design.
3. **Expired reservations are not actively swept** — `status` stays at
   `reserved` past `expiresAt` until either the operator runs a sweep
   or the reconciler classifies the row. Reads are correct in both
   states because `classifyExpired` is consulted by `computeBudgetAvailability`.
4. **No historical retention policy on `tls_budget_usage_events`** —
   Table grows linearly with reservation cardinality; future ops work
   should consider partitioning by `createdAt` and / or archival to
   cold storage.
5. **No fee/credit fields**: every reservation moves 1:1 with the
   amount. Platforms that charge fees or pay rebates will need a
   follow-up issue adding `feeMinor` / `creditMinor` columns.
6. **No multi-currency atomic reservation** — each reservation is
   pinned to one `currency`. Cross-currency exposures (e.g. USDC→XLM
   swaps during payment) need to be modelled as two reservations
   (one per currency) or a follow-up ledger column.
7. **No stable `availableAmount` index on `talosId` alone** — scoped
   by `(talosId, scopeKind)` for clarity. Aggregations over all scopes
   per agent require scanning the budget rows (`SELECT * FROM
   tls_budgets WHERE talosId = …`); acceptable for the current scale.
