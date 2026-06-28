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

// GET /api/talos/:id/financial-summary — Aggregated financial analytics
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
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
    const revenueBySource = await db
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
    const monthlyRevenue = await db
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
    const spendingByType = await db
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
    const spendingHistory = await db
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
    // Get all playbooks for this agent
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

    const totalPlaybookSales = playbookRows.reduce(
      (sum, p) => sum + p.purchaseCount,
      0,
    );
    const totalPlaybookRevenue = playbookRows.reduce(
      (sum, p) => sum + Number(p.price) * p.purchaseCount,
      0,
    );

    // ── Compute derived analytics ────────────────────────────────
    const totalRevenueNum = Number(revenueAllTime.totalRevenue);
    const revenueLast30Num = Number(revenueLast30.totalRevenue);
    const revenuePrev30Num = Number(revenuePrev30.totalRevenue);
    const totalSpentNum = Number(spendingAllTime.totalSpent);
    const spentLast30Num = Number(spendingLast30.totalSpent);
    const netProfitAllTime = totalRevenueNum - totalSpentNum;
    const netProfitLast30 = revenueLast30Num - spentLast30Num;

    // Revenue growth rate (30-day vs previous 30-day)
    const revenueGrowthRate =
      revenuePrev30Num > 0
        ? ((revenueLast30Num - revenuePrev30Num) / revenuePrev30Num) * 100
        : revenueLast30Num > 0
          ? 100
          : 0;

    // Annualized run rate based on last 30 days
    const annualizedRunRate = revenueLast30Num * 12;

    // Profit margin
    const profitMargin =
      totalRevenueNum > 0 ? (netProfitAllTime / totalRevenueNum) * 100 : 0;

    // Budget utilization (approved spending vs GTM budget)
    const gtmBudgetNum = Number(talos.gtmBudget);
    const budgetUtilization =
      gtmBudgetNum > 0 ? (totalSpentNum / gtmBudgetNum) * 100 : 0;

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
        profitMargin: Math.round(profitMargin * 100) / 100,
        revenueTransactionCount: revenueAllTime.transactionCount,
        spendingTransactionCount: spendingAllTime.spendCount,
        revenueBySource: revenueBySource.map((r) => ({
          source: r.source,
          total: Number(r.total),
          count: r.count,
        })),
        spendingByType: spendingByType.map((s) => ({
          type: s.type,
          total: Number(s.total),
          count: s.count,
        })),
      },

      trends: {
        revenueLast30Days: revenueLast30Num,
        revenuePrevious30Days: revenuePrev30Num,
        revenueGrowthRate: Math.round(revenueGrowthRate * 100) / 100,
        spendingLast30Days: spentLast30Num,
        netProfitLast30Days: netProfitLast30,
        annualizedRunRate,
        monthlyRevenue: monthlyRevenue.map((m) => ({
          month: m.month,
          revenue: Number(m.total),
          transactionCount: m.count,
        })),
      },

      budget: {
        gtmBudget: gtmBudgetNum,
        totalApprovedSpending: totalSpentNum,
        budgetUtilization: Math.round(budgetUtilization * 100) / 100,
        budgetRemaining: Math.max(0, gtmBudgetNum - totalSpentNum),
      },

      spendingHistory: spendingHistory.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        description: s.description,
        amount: Number(s.amount),
        decidedAt: s.decidedAt?.toISOString() ?? null,
        txHash: s.txHash ?? null,
        createdAt: s.createdAt.toISOString(),
      })),

      playbookSales: {
        totalPlaybooks: playbookRows.length,
        totalSales: totalPlaybookSales,
        totalRevenue: totalPlaybookRevenue,
        playbooks: playbookRows.map((p) => ({
          id: p.id,
          title: p.title,
          price: Number(p.price),
          currency: p.currency,
          category: p.category,
          status: p.status,
          purchaseCount: p.purchaseCount,
          salesRevenue: Number(p.price) * p.purchaseCount,
        })),
      },
    });
  } catch (err) {
    console.error("[financial-summary GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
