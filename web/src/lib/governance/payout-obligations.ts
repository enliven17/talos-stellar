/**
 * Read-only view of payout obligations that are still unsettled for an agent.
 *
 * Used by the retirement reconciliation run to record what is owed to patrons
 * before any teardown step executes. This module never writes: it cannot move,
 * void, or rewrite payout records, and it never touches Stellar.
 *
 * Amounts are exact decimal strings (numeric(18,6) in the database). They are
 * never parsed into floats, so USDC totals cannot drift.
 */
import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { tlsDividends } from "@/db/schema";

import { LifecycleError } from "./lifecycle";

/** Exact decimal, no exponent, at most 6 fractional digits (the column scale). */
const DECIMAL_AMOUNT = /^\d+(\.\d{1,6})?$/;

export function isDecimalAmount(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_AMOUNT.test(value);
}

/** A dividend row in any other status is still owed. */
export const SETTLED_DIVIDEND_STATUS = "completed";

export interface PayoutObligationSnapshot {
  /** Unsettled totals per currency, as exact decimal strings. */
  outstanding: Record<string, string>;
  /** Number of unsettled payout records included in the totals. */
  recordCount: number;
  source: "tls_dividends";
}

type Executor = Pick<typeof db, "select">;

export async function snapshotPayoutObligations(
  talosId: string,
  executor: Executor = db,
): Promise<PayoutObligationSnapshot> {
  const rows = await executor
    .select({
      currency: tlsDividends.currency,
      total: sql<string>`coalesce(sum(${tlsDividends.amount}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(tlsDividends)
    .where(and(eq(tlsDividends.talosId, talosId), ne(tlsDividends.status, SETTLED_DIVIDEND_STATUS)))
    .groupBy(tlsDividends.currency);

  const outstanding: Record<string, string> = {};
  let recordCount = 0;

  for (const row of rows) {
    // Fail closed: an amount we cannot represent exactly must never be recorded.
    if (!isDecimalAmount(row.total)) {
      throw new LifecycleError(
        "LIFECYCLE_PREREQUISITE_FAILED",
        "Payout snapshot produced a non-decimal amount",
        { currency: row.currency },
      );
    }
    outstanding[row.currency] = row.total;
    recordCount += Number(row.count);
  }

  return { outstanding, recordCount, source: "tls_dividends" };
}
