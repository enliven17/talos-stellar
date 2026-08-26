# #168 security(web): add nonce expiry and replay protection for signed requests

Closes #168

## Summary

Replaces the in-memory `Map<string, number>` nonce guard with persistent,
DB-backed replay protection. Consumed nonces are recorded in a new
`tls_consumed_nonces` table with a UNIQUE constraint on `(talosId, nonce)`,
so single-use semantics hold across **process restarts** and **concurrent
requests** without advisory locks.

## Changes

### DB schema (`web/src/db/schema.ts`, `web/drizzle/0015_add_consumed_nonces.sql`)

- New table `tls_consumed_nonces` with columns:
  - `id` — primary key
  - `talosId` — agent identifier
  - `nonce` — the 32-byte hex nonce
  - `expiry` — original auth expiry (Unix seconds, used by the vacuum)
  - `consumedAt` — wall-clock timestamp of consumption
- **UNIQUE index** on `(talosId, nonce)` — the DB enforces single-use,
  rejecting the second of two concurrent INSERTs with `code 23505`.
- Index on `(expiry)` for efficient vacuum queries.
- RLS policies: postgres role only (internal replay guard).

### Library (`web/src/lib/transfer-signature.ts`)

- `consumeTransferNonce()` → **async**, persists via
  `db.insert(tlsConsumedNonces).values(...)`. A unique-violation error
  (PostgreSQL code `23505`) returns `{ ok: false, reason: "replayed" }`.
- Extracted `validateNonceWindow()` as a pure, side-effect-free function
  for expiry-window checks (used by both the route and the DB-backed path).
- Added `pruneExpiredNonces()` — safe to call periodically; removes rows
  whose `expiry` is >1 hour in the past.
- Exported `NONCE_RETENTION_SECONDS = 3600` (1-hour retention buffer).

### Route (`web/src/app/api/talos/[id]/transfer/route.ts`)

- `consumeTransferNonce` call is now `await`-ed. Error responses unchanged.

### Tests (`web/tests/transfer-signature.test.ts`)

- **Replay test**: mocks `db.insert` to succeed on the first call and fail
  with `code 23505` on the second — verifies 200 / 409 split.
- **Race-condition test**: uses `Promise.all` with the same mocking pattern
  to prove exactly one of two concurrent requests succeeds.
- **`validateNonceWindow` tests**: pure-function tests for expired,
  expiry-too-far, and non-integer expiry inputs.

### Vacuum strategy (documented in migration & library)

DELETE FROM `tls_consumed_nonces` WHERE `expiry` < EXTRACT(EPOCH FROM NOW()) - 3600;

Safe to run periodically (e.g. via `pruneExpiredNonces()` call or pg_cron).
Rows survive well past the 5-minute max auth lifetime before cleanup.

## Test evidence

```text
✓ rejects a signed request with a tampered destination
✓ rejects a signed request with a tampered amount
✓ rejects a signed request with a tampered nonce
✓ rejects a signed request with a tampered expiry
✓ rejects an exact signed request when its nonce is replayed
✓ rejects an expired signed request
✓ rejects an authorization outside the five-minute expiry window
✓ rejects non-canonical and ambiguous request encodings
✓ validateNonceWindow returns ok for a valid expiry window
✓ validateNonceWindow returns expired when expiry is in the past
✓ validateNonceWindow returns expiry-too-far when expiry exceeds window
✓ validateNonceWindow returns expired for a non-integer expiry
✓ handles concurrent requests for the same nonce — exactly one succeeds
```

## Out of scope

Production deployment, live secret changes, or unrelated refactors.
