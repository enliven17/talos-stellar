import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  tlsTalos,
  tlsRevenues,
  tlsApprovals,
  tlsPlaybooks,
  tlsPlaybookPurchases,
} from "@/db/schema";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

/**
 * Monetary Value Representation Standard:
 * Monetary values in financial summary responses are represented as JSON numbers
 * rounded precisely to 6 decimal places (matching database precision 18, scale 6).
 * Safe parsing converts strings, numbers, nulls, and edge cases to clean numbers,
 * preventing floating-point representation artifacts (e.g. 0.30000000000000004),
 * precision loss on large integer/Stellar values, NaN/Infinity propagation, and
 * invalid states from negative or corrupted database rows.
 */
export function toMonetaryValue(
  val: unknown,
  options?: { allowNegative?: boolean; decimals?: number },
): number {
  if (val === null || val === undefined) return 0;
  let num: number;
  if (typeof val === "number") {
    num = val;
  } else if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return 0;
    num = Number(trimmed);
  } else {
    return 0;
  }

  if (Number.isNaN(num) || !Number.isFinite(num)) return 0;

  if (!options?.allowNegative && num < 0) {
    return 0;
  }

  const decimals = options?.decimals ?? 6;
  const factor = 10 ** decimals;
  return Math.round((num + Number.EPSILON) * factor) / factor;
}

// GET /api/talos/:id/financial-summary — Aggregated financial analytics
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["revenue:read"]);
    if (!auth.ok) return auth.response;

    // ── Verify the TALOS agent exists ─────────────────────────────
    const talos = await db
      .select({
        id: tlsTalos.id,
        name: tlsTalos.name,
        category: tlsTalos.category,
        status: tlsTalos.status,
        gtmBudget: tlsTalos.gtmBudget,
        createdAt: tlsTalos.createdAt,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // ── Time boundaries for trend calculations ────────────────────
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // ── Revenue aggregation (all-time + last 30 days + previous 30 days) ──
    const [revenueAllTime] = await db
      .select({
        totalRevenue: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        transactionCount: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id));

    const [revenueLast30] = await db
      .select({
        totalRevenue: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        transactionCount: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(
        and(
          eq(tlsRevenues.talosId, id),
          gte(tlsRevenues.createdAt, thirtyDaysAgo),
        ),
      );

    const [revenuePrev30] = await db
      .select({
        totalRevenue: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
      })
      .from(tlsRevenues)
      .where(
        and(
          eq(tlsRevenues.talosId, id),
          gte(tlsRevenues.createdAt, sixtyDaysAgo),
          sql`${tlsRevenues.createdAt} < ${thirtyDaysAgo}`,
        ),
      );

    // ── Revenue breakdown by source ──────────────────────────────
    const revenueBySourceRows = await db
      .select({
        source: tlsRevenues.source,
        total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id))
      .groupBy(tlsRevenues.source);

    // ── Monthly revenue for run-rate trend (last 6 months) ───────
    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    const monthlyRevenueRows = await db
      .select({
        month: sql<string>`to_char(${tlsRevenues.createdAt}, 'YYYY-MM')`,
        total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(
        and(
          eq(tlsRevenues.talosId, id),
          gte(tlsRevenues.createdAt, sixMonthsAgo),
        ),
      )
      .groupBy(sql`to_char(${tlsRevenues.createdAt}, 'YYYY-MM')`)
      .orderBy(sql`to_char(${tlsRevenues.createdAt}, 'YYYY-MM')`);

    // ── Spending aggregation (approved approvals with amounts) ───
    const [spendingAllTime] = await db
      .select({
        totalSpent: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        spendCount: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
        ),
      );

    const [spendingLast30] = await db
      .select({
        totalSpent: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        spendCount: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
          gte(tlsApprovals.createdAt, thirtyDaysAgo),
        ),
      );

    // ── Spending breakdown by type ───────────────────────────────
    const spendingByTypeRows = await db
      .select({
        type: tlsApprovals.type,
        total: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
        ),
      )
      .groupBy(tlsApprovals.type);

    // ── Recent spending history (last 20 approved with amounts) ──
    const spendingHistoryRows = await db
      .select({
        id: tlsApprovals.id,
        type: tlsApprovals.type,
        title: tlsApprovals.title,
        description: tlsApprovals.description,
        amount: tlsApprovals.amount,
        decidedAt: tlsApprovals.decidedAt,
        txHash: tlsApprovals.txHash,
        createdAt: tlsApprovals.createdAt,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
        ),
      )
      .orderBy(desc(tlsApprovals.createdAt))
      .limit(20);

    // ── Playbook sales metrics ───────────────────────────────────
    const playbookRows = await db
      .select({
        id: tlsPlaybooks.id,
        title: tlsPlaybooks.title,
        price: tlsPlaybooks.price,
        currency: tlsPlaybooks.currency,
        category: tlsPlaybooks.category,
        status: tlsPlaybooks.status,
        purchaseCount: sql<number>`count(${tlsPlaybookPurchases.id})::int`,
        totalSalesAmount: sql<string>`coalesce(sum(${tlsPlaybooks.price}), '0')`,
      })
      .from(tlsPlaybooks)
      .leftJoin(
        tlsPlaybookPurchases,
        eq(tlsPlaybooks.id, tlsPlaybookPurchases.playbookId),
      )
      .where(eq(tlsPlaybooks.talosId, id))
      .groupBy(
        tlsPlaybooks.id,
        tlsPlaybooks.title,
        tlsPlaybooks.price,
        tlsPlaybooks.currency,
        tlsPlaybooks.category,
        tlsPlaybooks.status,
      );

    // ── Compute derived monetary analytics ───────────────────────
    const totalRevenueNum = toMonetaryValue(revenueAllTime?.totalRevenue);
    const revenueLast30Num = toMonetaryValue(revenueLast30?.totalRevenue);
    const revenuePrev30Num = toMonetaryValue(revenuePrev30?.totalRevenue);
    const totalSpentNum = toMonetaryValue(spendingAllTime?.totalSpent);
    const spentLast30Num = toMonetaryValue(spendingLast30?.totalSpent);

    const netProfitAllTime = toMonetaryValue(totalRevenueNum - totalSpentNum, {
      allowNegative: true,
    });
    const netProfitLast30 = toMonetaryValue(revenueLast30Num - spentLast30Num, {
      allowNegative: true,
    });

    const revenueGrowthRateRaw =
      revenuePrev30Num > 0
        ? ((revenueLast30Num - revenuePrev30Num) / revenuePrev30Num) * 100
        : revenueLast30Num > 0
          ? 100
          : 0;
    const revenueGrowthRate = toMonetaryValue(revenueGrowthRateRaw, {
      allowNegative: true,
      decimals: 2,
    });

    const annualizedRunRate = toMonetaryValue(revenueLast30Num * 12);

    const profitMarginRaw =
      totalRevenueNum > 0 ? (netProfitAllTime / totalRevenueNum) * 100 : 0;
    const profitMargin = toMonetaryValue(profitMarginRaw, {
      allowNegative: true,
      decimals: 2,
    });

    const gtmBudgetNum = toMonetaryValue(talos.gtmBudget);
    const budgetUtilizationRaw =
      gtmBudgetNum > 0 ? (totalSpentNum / gtmBudgetNum) * 100 : 0;
    const budgetUtilization = toMonetaryValue(budgetUtilizationRaw, {
      allowNegative: false,
      decimals: 2,
    });

    const budgetRemaining = toMonetaryValue(
      Math.max(0, gtmBudgetNum - totalSpentNum),
    );

    const revenueTransactionCount = Math.max(
      0,
      Number(revenueAllTime?.transactionCount) || 0,
    );
    const spendingTransactionCount = Math.max(
      0,
      Number(spendingAllTime?.spendCount) || 0,
    );

    const revenueBySource = (revenueBySourceRows || []).map((r) => ({
      source: r.source,
      total: toMonetaryValue(r.total),
      count: Math.max(0, Number(r.count) || 0),
    }));

    const monthlyRevenue = (monthlyRevenueRows || []).map((m) => ({
      month: m.month,
      revenue: toMonetaryValue(m.total),
      transactionCount: Math.max(0, Number(m.count) || 0),
    }));

    const spendingByType = (spendingByTypeRows || []).map((s) => ({
      type: s.type,
      total: toMonetaryValue(s.total),
      count: Math.max(0, Number(s.count) || 0),
    }));

    const spendingHistory = (spendingHistoryRows || []).map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      description: s.description ?? null,
      amount: toMonetaryValue(s.amount),
      decidedAt: s.decidedAt ? new Date(s.decidedAt).toISOString() : null,
      txHash: s.txHash ?? null,
      createdAt:
        typeof s.createdAt === "string"
          ? s.createdAt
          : new Date(s.createdAt).toISOString(),
    }));

    const playbooks = (playbookRows || []).map((p) => {
      const count = Math.max(0, Number(p.purchaseCount) || 0);
      const price = toMonetaryValue(p.price);
      const salesRevenue = toMonetaryValue(price * count);
      return {
        id: p.id,
        title: p.title,
        price,
        currency: p.currency,
        category: p.category,
        status: p.status,
        purchaseCount: count,
        salesRevenue,
      };
    });

    const totalPlaybookSales = playbooks.reduce(
      (sum, p) => sum + p.purchaseCount,
      0,
    );
    const totalPlaybookRevenue = toMonetaryValue(
      playbooks.reduce((sum, p) => sum + p.salesRevenue, 0),
    );

    // ── Build response ───────────────────────────────────────────
    return Response.json({
      talosId: talos.id,
      talosName: talos.name,
      category: talos.category,
      status: talos.status,
      generatedAt: now.toISOString(),

      cashFlow: {
        totalRevenue: totalRevenueNum,
        totalSpending: totalSpentNum,
        netProfit: netProfitAllTime,
        profitMargin,
        revenueTransactionCount,
        spendingTransactionCount,
        revenueBySource,
        spendingByType,
      },

      trends: {
        revenueLast30Days: revenueLast30Num,
        revenuePrevious30Days: revenuePrev30Num,
        revenueGrowthRate,
        spendingLast30Days: spentLast30Num,
        netProfitLast30Days: netProfitLast30,
        annualizedRunRate,
        monthlyRevenue,
      },

      budget: {
        gtmBudget: gtmBudgetNum,
        totalApprovedSpending: totalSpentNum,
        budgetUtilization,
        budgetRemaining,
      },

      spendingHistory,

      playbookSales: {
        totalPlaybooks: playbooks.length,
        totalSales: totalPlaybookSales,
        totalRevenue: totalPlaybookRevenue,
        playbooks,
      },
    });
  } catch (err) {
    console.error("[financial-summary GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
