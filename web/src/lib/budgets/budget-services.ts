/**
 * A2A Budget — Transactional Service Module
 * ─────────────────────────────────────────
 *
 * Side-effectful layer that wraps the pure reconciliation helpers in
 * atomic Postgres transactions.  All write paths use `withTransactionRetry`
 * for bounded retry on serialization failures / deadlocks / connection
 * drops, and they acquire a row-level write lock on the matching
 * `tls_budgets` row before computing the available amount so concurrent
 * reservations against the same scope cannot race past each other.
 *
 * Sensitive-data: only reservation id + amount + scope kind are logged.
 * Customer payloads (`metadata`) and idempotency keys are never logged in
 * full beyond the prefix used for correlation.
 */

import { createId } from "@paralleldrive/cuid2";
import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import {
  tlsBudgets,
  tlsBudgetReservations,
  tlsBudgetUsageEvents,
} from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  computeBudgetAvailability,
  isTerminalState,
  isValidReservationTransition,
  isReleaseState,
  ReservationState,
  toBigInt,
} from "./reconciliation";

// ─── Errors ────────────────────────────────────────────────────────

export class BudgetError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(opts: { message: string; statusCode: number; code: string }) {
    super(opts.message);
    this.name = "BudgetError";
    this.statusCode = opts.statusCode;
    this.code = opts.code;
  }
}

// ─── Types ─────────────────────────────────────────────────────────

export type ScopeKind =
  | "global"
  | "rolling"
  | "category"
  | "asset"
  | "transaction"
  | "counterparty";

export interface ReserveBudgetParams {
  talosId: string;
  scopeKind: ScopeKind;
  scopeValue: string | null;
  amountMinor: bigint;
  currency?: string;
  counterpartyId?: string;
  category?: string;
  assetCode?: string;
  txHash?: string;
  jobId?: string;
  expiresInSeconds: number;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ReservationRecord {
  id: string;
  talosId: string;
  budgetId: string;
  amount: string;
  status: ReservationState;
  expiresAt: string | null;
  fencingToken: number;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface BudgetRecord {
  id: string;
  talosId: string;
  scopeKind: ScopeKind;
  scopeValue: string | null;
  windowSeconds: number | null;
  limitAmount: string;
  availableAmount: string;
  currency: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionParams {
  talosId: string;
  reservationId: string;
  toStatus: ReservationState;
  fencingToken: number;
  reason?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface ReconcileResult {
  budgetId: string;
  talosId: string;
  scopeKind: ScopeKind;
  scopeValue: string | null;
  limitAmount: string;
  computedAvailable: string;
  storedAvailable: string | null;
  usedAmount: string;
  activeReservations: number;
  matchingEvents: number;
  mismatched: boolean;
  repaired: boolean;
  windowSeconds: number | null;
  asOf: string;
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Normalise bigint/number/string columns returned by Drizzle into
 * bigint.  Numeric(precision,0) and bigint modes both appear in the
 * table DDL — perform the conversion at the boundary so downstream code
 * only deals with bigint arithmetic.
 */
function readBig(v: bigint | number | string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return toBigInt(v);
}

// ─── List / Read ───────────────────────────────────────────────────

export async function listBudgetsForAgent(
  talosId: string,
): Promise<BudgetRecord[]> {
  const rows = await defaultDb
    .select()
    .from(tlsBudgets)
    .where(eq(tlsBudgets.talosId, talosId));
  return rows.map((r) => ({
    id: r.id,
    talosId: r.talosId,
    scopeKind: r.scopeKind as ScopeKind,
    scopeValue: r.scopeValue ?? null,
    windowSeconds: r.windowSeconds ?? null,
    limitAmount: readBig(r.limitAmount).toString(),
    availableAmount: readBig(r.availableAmount).toString(),
    currency: r.currency,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// ─── Reserve ───────────────────────────────────────────────────────

/**
 * Atomically reserve `amountMinor` from the budget matching
 * `(talosId, scopeKind, scopeValue)`.
 *
 * Concurrency contract:
 *   - Acquires FOR UPDATE on the budget row inside the transaction.
 *   - Recomputes the available amount from the live reservation+event
 *     ledger (not just `tls_budgets.availableAmount`) so concurrent
 *     reservations that have not yet committed the availableAmount
 *     update cannot overflow the limit.
 *   - Inserts the new reservation row paired with a 'reserve' usage
 *     event so reconciliation can always reproduce the same answer.
 *
 * Idempotency: if `idempotencyKey` is supplied, the partial unique
 * index `tls_budget_reservations_talosId_idempotencyKey_unique` enforces
 * uniqueness at the database level — concurrent duplicates raise PG 23505
 * which we surface as BudgetError("idempotency_conflict").
 */
export async function reserveBudget(
  params: ReserveBudgetParams,
): Promise<ReservationRecord> {
  if (params.amountMinor <= 0n) {
    throw new BudgetError({
      code: "invalid_amount",
      statusCode: 400,
      message: "amountMinor must be a positive integer",
    });
  }
  if (!params.talosId || typeof params.talosId !== "string") {
    throw new BudgetError({
      code: "invalid_talos_id",
      statusCode: 400,
      message: "talosId is required",
    });
  }

  try {
    return await withTransactionRetry(
      (tx) => doReserve(tx, params),
      { category: "RESERVATION" },
    );
  } catch (err) {
    if (
      err instanceof BudgetError ||
      (err as { name?: string })?.name === "BudgetError"
    ) {
      throw err;
    }
    // Map Postgres unique-index violations from the partial-unique
    // idempotency index into BudgetError.
    const obj = err as { code?: string; constraint?: string } | null;
    if (obj?.code === "23505" && String(obj.constraint ?? "").includes("idempotencyKey")) {
      throw new BudgetError({
        code: "idempotency_conflict",
        statusCode: 409,
        message: "Reservation with this Idempotency-Key already exists",
      });
    }
    throw err;
  }
}

async function doReserve(
  tx: any,
  params: ReserveBudgetParams,
): Promise<ReservationRecord> {
  // 1. Lock the budget row for the duration of the transaction.
  const scopeValueWhere =
    params.scopeValue == null
      ? sql`"scopeValue" IS NULL`
      : eq(tlsBudgets.scopeValue, params.scopeValue);

  const [budget] = await tx
    .select()
    .from(tlsBudgets)
    .where(
      and(
        eq(tlsBudgets.talosId, params.talosId),
        eq(tlsBudgets.scopeKind, params.scopeKind),
        scopeValueWhere,
      ),
    )
    .for("update")
    .limit(1);

  if (!budget) {
    throw new BudgetError({
      code: "budget_not_found",
      statusCode: 404,
      message:
        `No budget configured for ${params.talosId} ` +
        `(scopeKind='${params.scopeKind}', scopeValue=${JSON.stringify(params.scopeValue)})`,
    });
  }
  if (!budget.enabled) {
    throw new BudgetError({
      code: "budget_disabled",
      statusCode: 409,
      message: "Budget is currently disabled",
    });
  }

  // 2. Idempotency pre-check (the partial unique index is the
  // authoritative gate; this is a fast-path to avoid recomputing).
  if (params.idempotencyKey) {
    const [dup] = await tx
      .select({ id: tlsBudgetReservations.id })
      .from(tlsBudgetReservations)
      .where(
        and(
          eq(tlsBudgetReservations.talosId, params.talosId),
          eq(tlsBudgetReservations.idempotencyKey, params.idempotencyKey),
        ),
      )
      .limit(1);
    if (dup) {
      throw new BudgetError({
        code: "idempotency_conflict",
        statusCode: 409,
        message:
          "Reservation with this Idempotency-Key already exists for this agent",
      });
    }
  }

  // 3. Recompute available from the live ledger.
  const now = new Date();
  const cutoffMs =
    budget.windowSeconds != null
      ? new Date(now.getTime() - budget.windowSeconds * 1000)
      : null;

  const activeReservationConditions = [
    eq(tlsBudgetReservations.budgetId, budget.id),
    eq(tlsBudgetReservations.status, "reserved"),
  ];
  if (cutoffMs != null) {
    activeReservationConditions.push(
      sql`"tls_budget_reservations"."createdAt" >= ${cutoffMs}`,
    );
  }

  const reservations = await tx
    .select({
      id: tlsBudgetReservations.id,
      budgetId: tlsBudgetReservations.budgetId,
      amount: tlsBudgetReservations.amount,
      status: tlsBudgetReservations.status,
      expiresAt: tlsBudgetReservations.expiresAt,
      createdAt: tlsBudgetReservations.createdAt,
    })
    .from(tlsBudgetReservations)
    .where(and(...activeReservationConditions));

  const eventConditions = [eq(tlsBudgetUsageEvents.budgetId, budget.id)];
  if (cutoffMs != null) {
    eventConditions.push(
      sql`"tls_budget_usage_events"."createdAt" >= ${cutoffMs}`,
    );
  }

  const events = await tx
    .select({
      id: tlsBudgetUsageEvents.id,
      budgetId: tlsBudgetUsageEvents.budgetId,
      reservationId: tlsBudgetUsageEvents.reservationId,
      kind: tlsBudgetUsageEvents.kind,
      amount: tlsBudgetUsageEvents.amount,
      createdAt: tlsBudgetUsageEvents.createdAt,
    })
    .from(tlsBudgetUsageEvents)
    .where(and(...eventConditions));

  const available = computeBudgetAvailability({
    budget,
    reservations,
    events,
    now,
  });

  if (params.amountMinor > available) {
    throw new BudgetError({
      code: "insufficient_budget",
      statusCode: 409,
      message:
        `Reservation ${params.amountMinor.toString()} > available ${available.toString()} ` +
        `for scope ${params.scopeKind}` +
        (params.scopeValue != null ? `:${params.scopeValue}` : ""),
    });
  }

  // 4. Persist the reservation + event.
  const reservationId = createId();
  const expiresAt = new Date(now.getTime() + params.expiresInSeconds * 1000);

  await tx.insert(tlsBudgetReservations).values({
    id: reservationId,
    talosId: params.talosId,
    budgetId: budget.id,
    amount: params.amountMinor,
    status: "reserved",
    idempotencyKey: params.idempotencyKey ?? null,
    counterpartyId: params.counterpartyId ?? null,
    category: params.category ?? null,
    assetCode: params.assetCode ?? null,
    txHash: params.txHash ?? null,
    jobId: params.jobId ?? null,
    expiresAt,
    fencingToken: 1,
  });

  await tx.insert(tlsBudgetUsageEvents).values({
    id: createId(),
    talosId: params.talosId,
    budgetId: budget.id,
    reservationId,
    kind: "reserve",
    amount: params.amountMinor,
    reason: "reservation_created",
    metadata: params.metadata ?? null,
  });

  // 5. Mirror availableAmount for non-rolling scopes so subsequent reads
  // are cheap.  Rolling scopes intentionally skip the mirror so the next
  // reserve recomputes against the rolling window.
  if (budget.windowSeconds == null) {
    const newAvailable = available - params.amountMinor;
    await tx
      .update(tlsBudgets)
      .set({
        availableAmount: newAvailable < 0n ? 0n : newAvailable,
        updatedAt: now,
      })
      .where(eq(tlsBudgets.id, budget.id));
  }

  logger.info(
    {
      reservationId,
      talosId: params.talosId,
      budgetId: budget.id,
      scopeKind: budget.scopeKind,
      scopeValue: budget.scopeValue,
      amountMinor: params.amountMinor.toString(),
      windowSeconds: budget.windowSeconds,
    },
    "budget_reservation_created",
  );

  return {
    id: reservationId,
    talosId: params.talosId,
    budgetId: budget.id,
    amount: params.amountMinor.toString(),
    status: "reserved",
    expiresAt: expiresAt.toISOString(),
    fencingToken: 1,
    idempotencyKey: params.idempotencyKey ?? null,
    createdAt: now.toISOString(),
  };
}

// ─── Transition ────────────────────────────────────────────────────

/**
 * Apply a state transition to a single reservation.  All paths read the
 * latest fencing token from the row and require the caller to present
 * the matching token, providing stale-worker defence parallel to the
 * job-lease module.
 *
 * Release events (released/expired/refunded) credit the used amount
 * back to the parent budget's availableAmount mirror when the budget is
 * non-rolling — rolling scopes recompute against the rolling window so
 * no mirror update is needed.
 */
export async function transitionReservation(
  params: TransitionParams,
): Promise<ReservationRecord> {
  return withTransactionRetry(
    (tx) => doTransition(tx, params),
    { category: "RESERVATION" },
  );
}

async function doTransition(
  tx: any,
  params: TransitionParams,
): Promise<ReservationRecord> {
  const [reservation] = await tx
    .select()
    .from(tlsBudgetReservations)
    .where(
      and(
        eq(tlsBudgetReservations.id, params.reservationId),
        eq(tlsBudgetReservations.talosId, params.talosId),
      ),
    )
    .for("update")
    .limit(1);

  if (!reservation) {
    throw new BudgetError({
      code: "reservation_not_found",
      statusCode: 404,
      message: "Reservation not found for this agent",
    });
  }

  const fromStatus = String(reservation.status) as ReservationState;

  if (reservation.fencingToken !== params.fencingToken) {
    throw new BudgetError({
      code: "stale_fencing_token",
      statusCode: 409,
      message:
        `Stale fencing token: supplied=${params.fencingToken}, ` +
        `current=${reservation.fencingToken}`,
    });
  }
  if (isTerminalState(fromStatus)) {
    throw new BudgetError({
      code: "already_terminal",
      statusCode: 409,
      message: `Reservation is already terminal (status=${fromStatus})`,
    });
  }
  if (!isValidReservationTransition(fromStatus, params.toStatus)) {
    throw new BudgetError({
      code: "invalid_transition",
      statusCode: 400,
      message: `Invalid transition: ${fromStatus} → ${params.toStatus}`,
    });
  }

  const amount = readBig(reservation.amount);
  const nextToken = reservation.fencingToken + 1;

  await tx
    .update(tlsBudgetReservations)
    .set({
      status: params.toStatus,
      fencingToken: nextToken,
      txHash: params.txHash ?? reservation.txHash ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tlsBudgetReservations.id, reservation.id));

  await tx.insert(tlsBudgetUsageEvents).values({
    id: createId(),
    talosId: params.talosId,
    budgetId: reservation.budgetId,
    reservationId: reservation.id,
    kind: params.toStatus,
    amount: isReleaseState(params.toStatus) ? -amount : amount,
    reason: params.reason ?? null,
    metadata: params.metadata ?? null,
  });

  // Credit funds back to the parent budget for release events on
  // non-rolling scopes only.
  if (isReleaseState(params.toStatus)) {
    const [budgetRow] = await tx
      .select()
      .from(tlsBudgets)
      .where(eq(tlsBudgets.id, reservation.budgetId))
      .limit(1);
    if (budgetRow && budgetRow.windowSeconds == null) {
      const current = readBig(budgetRow.availableAmount);
      await tx
        .update(tlsBudgets)
        .set({ availableAmount: current + amount, updatedAt: new Date() })
        .where(eq(tlsBudgets.id, reservation.budgetId));
    }
  }

  logger.info(
    {
      reservationId: reservation.id,
      talosId: params.talosId,
      from: fromStatus,
      to: params.toStatus,
      fencingToken: nextToken,
    },
    "budget_reservation_transition",
  );

  return {
    id: reservation.id,
    talosId: params.talosId,
    budgetId: reservation.budgetId,
    amount: amount.toString(),
    status: params.toStatus,
    expiresAt: reservation.expiresAt ? reservation.expiresAt.toISOString() : null,
    fencingToken: nextToken,
    idempotencyKey: reservation.idempotencyKey ?? null,
    createdAt: reservation.createdAt.toISOString(),
  };
}

// ─── Reconcile ─────────────────────────────────────────────────────

/**
 * Rebuild the canonical available amount from the reservation+event
 * ledger and compare it to `tls_budgets.availableAmount`.  When they
 * diverge the caller can either:
 *   - dryRun: just report the mismatch (default false for ops endpoints)
 *   - repair-mode: UPDATE the mirror to match the math (non-rolling
 *     scopes only — rolling scopes always recompute on read)
 *
 * Reconciliations are deterministic given `(budget, reservations, events,
 * now)` and safe to re-run at any time.  No row locks are held during a
 * read-only reconciliation.
 */
export async function reconcileBudget(
  talosId: string,
  budgetId: string,
  options: { dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const [budget] = await defaultDb
    .select()
    .from(tlsBudgets)
    .where(
      and(eq(tlsBudgets.id, budgetId), eq(tlsBudgets.talosId, talosId)),
    )
    .limit(1);

  if (!budget) {
    throw new BudgetError({
      code: "budget_not_found",
      statusCode: 404,
      message: "Budget not found for this agent",
    });
  }

  const reservations = await defaultDb
    .select({
      id: tlsBudgetReservations.id,
      budgetId: tlsBudgetReservations.budgetId,
      amount: tlsBudgetReservations.amount,
      status: tlsBudgetReservations.status,
      expiresAt: tlsBudgetReservations.expiresAt,
      createdAt: tlsBudgetReservations.createdAt,
    })
    .from(tlsBudgetReservations)
    .where(
      and(
        eq(tlsBudgetReservations.budgetId, budget.id),
        eq(tlsBudgetReservations.talosId, talosId),
      ),
    );

  const events = await defaultDb
    .select({
      id: tlsBudgetUsageEvents.id,
      budgetId: tlsBudgetUsageEvents.budgetId,
      reservationId: tlsBudgetUsageEvents.reservationId,
      kind: tlsBudgetUsageEvents.kind,
      amount: tlsBudgetUsageEvents.amount,
      createdAt: tlsBudgetUsageEvents.createdAt,
    })
    .from(tlsBudgetUsageEvents)
    .where(
      and(
        eq(tlsBudgetUsageEvents.budgetId, budget.id),
        eq(tlsBudgetUsageEvents.talosId, talosId),
      ),
    );

  const now = new Date();
  const computedAvailable = computeBudgetAvailability({
    budget,
    reservations,
    events,
    now,
  });

  const storedAvailable = readBig(budget.availableAmount);
  const limit = readBig(budget.limitAmount);

  const mismatched =
    budget.windowSeconds == null && storedAvailable !== computedAvailable;
  let repaired = false;

  if (mismatched && !options.dryRun && budget.windowSeconds == null) {
    await defaultDb
      .update(tlsBudgets)
      .set({ availableAmount: computedAvailable, updatedAt: now })
      .where(eq(tlsBudgets.id, budget.id));
    repaired = true;
    logger.warn(
      {
        budgetId: budget.id,
        talosId,
        stored: storedAvailable.toString(),
        computed: computedAvailable.toString(),
      },
      "budget_reconciliation_repaired",
    );
  }

  const activeCount = reservations.filter((r) => {
    if (r.status !== "reserved") return false;
    if (!r.expiresAt) return true;
    return r.expiresAt.getTime() > now.getTime();
  }).length;

  return {
    budgetId: budget.id,
    talosId,
    scopeKind: budget.scopeKind as ScopeKind,
    scopeValue: budget.scopeValue ?? null,
    limitAmount: limit.toString(),
    computedAvailable: computedAvailable.toString(),
    storedAvailable: storedAvailable.toString(),
    usedAmount: (limit - computedAvailable).toString(),
    activeReservations: activeCount,
    matchingEvents: events.length,
    mismatched,
    repaired,
    windowSeconds: budget.windowSeconds ?? null,
    asOf: now.toISOString(),
  };
}

// ─── Setup ─────────────────────────────────────────────────────────

/**
 * Create or update a budget.  Idempotent on (talosId, scopeKind,
 * scopeValue).  Used at provisioning / configuration time by the agent
 * operator — not for the reserve path.
 */
export interface UpsertBudgetParams {
  talosId: string;
  scopeKind: ScopeKind;
  scopeValue: string | null;
  windowSeconds: number | null;
  limitAmountMinor: bigint;
  currency?: string;
  enabled?: boolean;
}

export async function upsertBudget(
  params: UpsertBudgetParams,
): Promise<BudgetRecord> {
  if (params.limitAmountMinor < 0n) {
    throw new BudgetError({
      code: "invalid_amount",
      statusCode: 400,
      message: "limitAmountMinor must be non-negative",
    });
  }
  if (params.scopeKind === "rolling" && (params.windowSeconds == null || params.windowSeconds <= 0)) {
    throw new BudgetError({
      code: "invalid_window",
      statusCode: 400,
      message: "rolling budgets require windowSeconds > 0",
    });
  }

  return withTransactionRetry(
    (tx) => doUpsertBudget(tx, params),
    { category: "RESERVATION" },
  );
}

async function doUpsertBudget(
  tx: any,
  params: UpsertBudgetParams,
): Promise<BudgetRecord> {
  const scopeValueWhere =
    params.scopeValue == null
      ? sql`"scopeValue" IS NULL`
      : eq(tlsBudgets.scopeValue, params.scopeValue);

  const [existing] = await tx
    .select()
    .from(tlsBudgets)
    .where(
      and(
        eq(tlsBudgets.talosId, params.talosId),
        eq(tlsBudgets.scopeKind, params.scopeKind),
        scopeValueWhere,
      ),
    )
    .for("update")
    .limit(1);

  const now = new Date();
  if (existing) {
    // Re-derive the mirror so committed reservations survive a limit change.
    // Reading the live ledger inside the same transaction (FOR UPDATE on the
    // budget row ensures no concurrent reservation can race us) prevents
    // silent data loss of encumbered funds when the operator grows or
    // shrinks the cap.
    const reservations = await tx
      .select({
        id: tlsBudgetReservations.id,
        budgetId: tlsBudgetReservations.budgetId,
        amount: tlsBudgetReservations.amount,
        status: tlsBudgetReservations.status,
        expiresAt: tlsBudgetReservations.expiresAt,
        createdAt: tlsBudgetReservations.createdAt,
      })
      .from(tlsBudgetReservations)
      .where(
        and(
          eq(tlsBudgetReservations.budgetId, existing.id),
          eq(tlsBudgetReservations.talosId, params.talosId),
        ),
      );
    const events = await tx
      .select({
        id: tlsBudgetUsageEvents.id,
        budgetId: tlsBudgetUsageEvents.budgetId,
        reservationId: tlsBudgetUsageEvents.reservationId,
        kind: tlsBudgetUsageEvents.kind,
        amount: tlsBudgetUsageEvents.amount,
        createdAt: tlsBudgetUsageEvents.createdAt,
      })
      .from(tlsBudgetUsageEvents)
      .where(
        and(
          eq(tlsBudgetUsageEvents.budgetId, existing.id),
          eq(tlsBudgetUsageEvents.talosId, params.talosId),
        ),
      );
    const recomputed = computeBudgetAvailability({
      budget: {
        ...existing,
        limitAmount: params.limitAmountMinor,
      },
      reservations,
      events,
      now,
    });

    await tx
      .update(tlsBudgets)
      .set({
        windowSeconds: params.windowSeconds,
        limitAmount: params.limitAmountMinor,
        availableAmount: recomputed,
        currency: params.currency ?? existing.currency,
        enabled: params.enabled ?? existing.enabled,
        updatedAt: now,
      })
      .where(eq(tlsBudgets.id, existing.id));

    const [row] = await tx
      .select()
      .from(tlsBudgets)
      .where(eq(tlsBudgets.id, existing.id))
      .limit(1);
    return toBudgetRecord(row);
  }

  const id = createId();
  await tx.insert(tlsBudgets).values({
    id,
    talosId: params.talosId,
    scopeKind: params.scopeKind,
    scopeValue: params.scopeValue,
    windowSeconds: params.windowSeconds,
    limitAmount: params.limitAmountMinor,
    availableAmount: params.limitAmountMinor,
    currency: params.currency ?? "USDC",
    enabled: params.enabled ?? true,
  });
  const [row] = await tx
    .select()
    .from(tlsBudgets)
    .where(eq(tlsBudgets.id, id))
    .limit(1);
  return toBudgetRecord(row);
}

function toBudgetRecord(r: any): BudgetRecord {
  return {
    id: r.id,
    talosId: r.talosId,
    scopeKind: r.scopeKind as ScopeKind,
    scopeValue: r.scopeValue ?? null,
    windowSeconds: r.windowSeconds ?? null,
    limitAmount: readBig(r.limitAmount).toString(),
    availableAmount: readBig(r.availableAmount).toString(),
    currency: r.currency,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
