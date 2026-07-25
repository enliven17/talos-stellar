## Summary

Implement a versioned reputation input ledger (`tls_reputation_ledger`) to persist authoritative, privacy-preserving, and replay-safe reputation evidence for TALOS providers. Decouple metrics computation from raw job payloads to protect sensitive payload details while ensuring provenance is fully auditable, idempotent, and rebuildable.

## Scope & Changes

### Database Layer
- **New Table**: `tls_reputation_ledger`
  - Columns: `id` (PK), `talosId` (FK to `tls_talos.id`), `serviceName` (text), `jobId` (text), `eventType` (text), `amount` (numeric), `counterparty` (text), `txHash` (text), `paymentSig` (text), `timestamp` (timestamp), `version` (text), `metadata` (jsonb), and `createdAt` (timestamp).
  - Indexes: Index on `talosId`, index on `jobId`, and a partial/unique index on `(jobId, eventType)` to enforce idempotency.
- **Relations**: Linked `tlsReputationLedger` to `tlsTalos` via relations in `web/src/db/relations.ts`.
- **Migration**: Generated `web/drizzle/0015_wonderful_shooting_star.sql` migration.

### Reputation Core
- Implemented `ingestReputationEvent` in `web/src/lib/reputation.ts` using `ON CONFLICT DO NOTHING` to ensure that duplicate events are idempotent.
- Refactored `getOrCreateReputation` in `web/src/lib/reputation.ts` to:
  1. Rebuild and recalculate provider reputation (score, confidence, samples, unique counterparties) directly from ledger events.
     - Completed: Job contains a `delivery` event.
     - Failed: Job has no `delivery` event but contains at least one of `deadline`, `dispute`, `refund`, or `cancellation`.
  2. Perform an automatic liveness scan for pending jobs whose lease has expired, automatically writing `deadline` events to the ledger.
  3. Update/cache the computed values in `tlsReputations` cache table.

### API Routes & Webhooks Integration
- **Job Creation (`POST /api/talos/:id/jobs`)**: Automatically records `'settled'`, `'counterparty'` events (and `'repeat'` if requester has prior jobs with the provider), plus `'delivery'` for instant jobs.
- **Job Fulfillment (`POST /api/jobs/:id/result`)**: Automatically records a `'delivery'` event.
- **Webhook Ingestion (`POST /api/commerce/cross-chain-webhook`)**: Automatically records `'settled'`, `'counterparty'`, `'repeat'`, and `'delivery'` events where applicable.
- **Manual Ingestion (`POST /api/reputation`)**: Implemented a POST endpoint with API Key authentication, rate-limiting, and validation:
  - Enforces eventType is one of the 8 allowed types.
  - Ensures amount is non-negative.
  - Guarantees event outcomes are either **server-observed** (matching jobId exists in the database) or **cryptographically linked** (valid `txHash` or `paymentSig` is present).
  - Triggers cache recalculations.

---

## Test Plan

- [x] Verified existing tests run cleanly and continue to pass.
- [x] Added comprehensive unit tests in `web/tests/reputation.unit.test.ts` covering:
  - Event ingestion and successful API flow.
  - Endpoint authorization & rate-limiting checks.
  - Input boundary validation (negative amount, missing fields, invalid type).
  - Provenance validation (requiring server-observed jobs or cryptographic tx links).
  - Ingestion idempotency (ignoring duplicate records).
  - Score rebuildability across multiple event types (disputes, refunds, cancellations).
- [x] Ran full unit test suites using Vitest:
  ```bash
  pnpm --dir web exec vitest run tests/async-jobs-revenue.unit.test.ts tests/cross-chain-webhook.unit.test.ts tests/db-retry.unit.test.ts tests/job-lease.unit.test.ts tests/reputation.unit.test.ts
  ```
  Result: **51 tests passed (5 passed test files)**.

---

## Visual Changes
No UI changes.
