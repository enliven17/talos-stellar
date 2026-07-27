-- Migration 0014: A2A Budget Reservations & Usage Accounting
-- ──────────────────────────────────────────────────────────
-- Adds three tables for persistent, atomic financial state for autonomous
-- commerce: a budget configuration table (limits, scopes, windows), a
-- durable reservation ledger, and an immutable usage-event journal.
--
-- All amounts are stored in **minor units** (bigint) to avoid floating-point
-- drift — USDC on Stellar is 1e-6 micro-units, so an upper-bound 1B USDC
-- budget fits in i64 (9.7e18) with significant headroom.
--
-- Scope kinds supported: global, rolling, category, asset, transaction,
-- counterparty.  A (talosId, scopeKind, scopeValue) tuple is unique — NULL
-- scopeValue is treated as distinct (one global budget per agent).
--
-- Idempotency: per-talosId key on tls_budget_reservations (partial unique
-- index WHERE idempotencyKey IS NOT NULL).  Concurrency: SELECT … FOR UPDATE
-- on the matching budget row inside withTransactionRetry.
--
-- This migration is purely additive.  Pre-existing tables and code paths are
-- untouched.  Rollback instructions live in BUDGETS.md.

-- ─── tls_budgets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tls_budgets" (
  "id"            text PRIMARY KEY NOT NULL,
  "talosId"       text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  -- 'global' | 'rolling' | 'category' | 'asset' | 'transaction' | 'counterparty'
  "scopeKind"     text NOT NULL,
  -- disambiguator: NULL for global, window name ('daily'|'hourly') for rolling,
  -- category name, asset code, counterparty id, etc. (capped at 200 chars)
  "scopeValue"    text,
  -- Only meaningful for rolling scopes. NULL when not applicable.
  "windowSeconds" integer,
  -- Upper bound for the minor-unit balance. For non-rolling scopes, also the
  -- highest value that `availableAmount` can ever reach.
  "limitAmount"   bigint NOT NULL,
  -- Mirror of the computed available amount for non-rolling scopes; avoids
  -- re-aggregating events+reservations on every read. Rolling scopes may
  -- hold a stale value and rely on `computeBudgetAvailability` for truth.
  "availableAmount" bigint NOT NULL,
  "currency"      text NOT NULL DEFAULT 'USDC',
  "enabled"       boolean NOT NULL DEFAULT true,
  "createdAt"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

-- A given (talos, scope) tuple is unique. NULL scopeValue treated as one
-- bucket per kind so each agent can have at most one 'global' + one
-- 'rolling' etc.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_budgets_talosId_scopeKind_scopeValue_unique"
  ON "tls_budgets" ("talosId", "scopeKind", "scopeValue");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_budgets_talosId_enabled_idx"
  ON "tls_budgets" ("talosId", "enabled");
--> statement-breakpoint

-- RLS consistent with other tables in this schema
ALTER TABLE "tls_budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "postgres_all_budgets" ON "tls_budgets"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_read_budgets" ON "tls_budgets"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint

-- ─── tls_budget_reservations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tls_budget_reservations" (
  "id"                  text PRIMARY KEY NOT NULL,
  "talosId"             text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "budgetId"            text NOT NULL REFERENCES "tls_budgets"("id") ON DELETE CASCADE,
  -- positive minor units
  "amount"              bigint NOT NULL,
  -- reserved | committed | settled | released | expired | refunded
  "status"              text NOT NULL DEFAULT 'reserved',
  -- Idempotency key scoped per talosId (partial unique below)
  "idempotencyKey"      text,
  -- Scope refs used for category/asset/counterparty-limit accounting. NULL
  -- when the reservation is only constrained at the parent (scopeKind) level.
  "counterpartyId"      text,
  "category"            text,
  "assetCode"           text,
  -- Optional user-supplied reference to a Stellar tx or commerce job.
  "txHash"              text,
  "jobId"               text,
  -- When the reservation auto-expires if not committed/settled (lazy).
  "expiresAt"           timestamp(3),
  -- Monotonic counter incremented at every state transition. Provided by
  -- the caller on transition to defend against stale-worker writes.
  "fencingToken"        integer NOT NULL DEFAULT 0,
  -- For refunds that are issued against a previously settled reservation.
  -- ON DELETE SET NULL preserves the audit trail if the parent reservation
  -- is purged (e.g. via manual cleanup); mirrors the same policy as
  -- tls_budget_usage_events.reservationId.
  "parentReservationId" text REFERENCES "tls_budget_reservations"("id") ON DELETE SET NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_budget_reservations_talosId_status_idx"
  ON "tls_budget_reservations" ("talosId", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_budget_reservations_budgetId_status_idx"
  ON "tls_budget_reservations" ("budgetId", "status");
--> statement-breakpoint

-- Lookup path for lazy expiry sweeps / cron cleanup
CREATE INDEX IF NOT EXISTS "tls_budget_reservations_expiresAt_idx"
  ON "tls_budget_reservations" ("expiresAt")
  WHERE "status" = 'reserved';
--> statement-breakpoint

-- Per-talosId idempotency. Same key may be reused across different agents.
CREATE UNIQUE INDEX IF NOT EXISTS "tls_budget_reservations_talosId_idempotencyKey_unique"
  ON "tls_budget_reservations" ("talosId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "tls_budget_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "postgres_all_budget_reservations" ON "tls_budget_reservations"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_read_budget_reservations" ON "tls_budget_reservations"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint

-- ─── tls_budget_usage_events ────────────────────────────────────────────
-- Immutable event log. Drives reconciliation. amount is a signed delta in
-- minor units (positive for in-flows, negative for refunds/release).
CREATE TABLE IF NOT EXISTS "tls_budget_usage_events" (
  "id"            text PRIMARY KEY NOT NULL,
  "talosId"       text NOT NULL REFERENCES "tls_talos"("id") ON DELETE CASCADE,
  "budgetId"      text NOT NULL REFERENCES "tls_budgets"("id") ON DELETE CASCADE,
  "reservationId" text REFERENCES "tls_budget_reservations"("id") ON DELETE SET NULL,
  -- reserve | commit | settle | refund | expire | release | reject
  "kind"          text NOT NULL,
  -- Signed delta: positive for in-flows (reserve/commit/settle), negative
  -- for releases/refunds. Always non-zero.
  "amount"        bigint NOT NULL,
  "reason"        text,
  "metadata"      jsonb,
  "createdAt"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_budget_usage_events_budgetId_createdAt_idx"
  ON "tls_budget_usage_events" ("budgetId", "createdAt" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_budget_usage_events_reservationId_idx"
  ON "tls_budget_usage_events" ("reservationId")
  WHERE "reservationId" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "tls_budget_usage_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "postgres_all_budget_usage_events" ON "tls_budget_usage_events"
  FOR ALL TO postgres USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "auth_read_budget_usage_events" ON "tls_budget_usage_events"
  FOR SELECT TO authenticated USING (true);
--> statement-breakpoint
