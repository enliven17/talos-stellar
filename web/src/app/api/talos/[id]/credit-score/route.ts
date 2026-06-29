import { db } from "@/db";
import { tlsTalos, tlsRevenues, tlsApprovals, tlsPatrons } from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

// GET /api/talos/:id/credit-score — Credit scoring based on financial health
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const talos = await db
      .select({
        id: tlsTalos.id,
        name: tlsTalos.name,
        createdAt: tlsTalos.createdAt,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // ── Historical revenue metrics (7-day, 30-day, 90-day) ──
    const [revenue7d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(and(eq(tlsRevenues.talosId, id), gte(tlsRevenues.createdAt, sevenDaysAgo)));

    const [revenue30d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(and(eq(tlsRevenues.talosId, id), gte(tlsRevenues.createdAt, thirtyDaysAgo)));

    const [revenue90d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsRevenues)
      .where(and(eq(tlsRevenues.talosId, id), gte(tlsRevenues.createdAt, ninetyDaysAgo)));

    // ── Historical debt (approved approvals with amounts) ──
    const [debt7d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
          gte(tlsApprovals.createdAt, sevenDaysAgo)
        )
      );

    const [debt30d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
          gte(tlsApprovals.createdAt, thirtyDaysAgo)
        )
      );

    const [debt90d] = await db
      .select({
        total: sql<string>`coalesce(sum(${tlsApprovals.amount}), '0')`,
        count: sql<number>`count(*)::int`,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.status, "approved"),
          sql`${tlsApprovals.amount} is not null`,
          gte(tlsApprovals.createdAt, ninetyDaysAgo)
        )
      );

    // ── Patron equity (number of active patrons) ──
    const [patronStats] = await db
      .select({
        count: sql<number>`count(*)::int`,
        totalHoldings: sql<string>`coalesce(sum(${tlsPatrons.pulseAmount}), '0')`,
      })
      .from(tlsPatrons)
      .where(and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.status, "active")));

    // ── Convert to numbers ──
    const rev7dNum = Number(revenue7d.total);
    const rev30dNum = Number(revenue30d.total);
    const rev90dNum = Number(revenue90d.total);
    const debt7dNum = Number(debt7d.total);
    const debt30dNum = Number(debt30d.total);
    const debt90dNum = Number(debt90d.total);

    // ── Compute derived metrics ──

    // Weekly net income (7-day average, annualized hint)
    const netWeeklyIncome = rev7dNum - debt7dNum;
    const annualizedWeeklyIncome = netWeeklyIncome * 52;

    // Debt-to-revenue ratios (prevent division by zero)
    const debtToRevenue7d = rev7dNum > 0 ? (debt7dNum / rev7dNum) * 100 : 0;
    const debtToRevenue30d = rev30dNum > 0 ? (debt30dNum / rev30dNum) * 100 : 0;
    const debtToRevenue90d = rev90dNum > 0 ? (debt90dNum / rev90dNum) * 100 : 0;

    // Average monthly spending trend (for borrowing capacity)
    const avgMonthlySpending30d = debt30dNum / (30 / 30); // Last 30 days

    // Borrowing limit: based on sustainable debt (2x monthly revenue allows up to 60% debt-to-revenue)
    // Conservative model: monthly revenue * 0.6 = max sustainable debt per month
    const monthlyRevenue30d = rev30dNum / (30 / 30);
    const sustainableBorrowingLimit = monthlyRevenue30d * 0.6;
    const borrowingUtilization = monthlyRevenue30d > 0
      ? (avgMonthlySpending30d / sustainableBorrowingLimit) * 100
      : 0;

    // Credit score calculation (0-100 scale)
    // Factors: revenue stability, debt-to-revenue ratio, patron engagement
    let creditScore = 50; // Base score

    // Revenue factor (+30 points max)
    if (rev30dNum > 0) {
      const revenueConsistency = Math.min((revenue30d.count / 30) * 100, 100); // Activity rate
      creditScore += (revenueConsistency / 100) * 30;
    }

    // Debt-to-revenue factor (+40 points max, penalize high ratios)
    const debtPenalty = Math.max(0, Math.min(debtToRevenue30d, 100));
    creditScore += (1 - debtPenalty / 100) * 40;

    // Patron engagement factor (+10 points max)
    if (patronStats.count > 0) {
      creditScore += Math.min(10, patronStats.count); // Up to 10 patrons for full points
    }

    // Liquidity factor (net income trend)
    if (netWeeklyIncome > 0) {
      creditScore = Math.min(100, creditScore + 5); // Bonus for positive cash flow
    }

    // Ensure score is in valid range
    creditScore = Math.max(0, Math.min(100, creditScore));

    // Credit grade based on score
    const gradeMap: { [key: number]: string } = {
      85: "A", 75: "B", 65: "C", 50: "D"
    };
    let creditGrade = "F";
    for (const [threshold, grade] of Object.entries(gradeMap).sort(([a], [b]) => Number(b) - Number(a))) {
      if (creditScore >= Number(threshold)) {
        creditGrade = grade;
        break;
      }
    }

    // ── Build response ──
    return Response.json({
      talosId: talos.id,
      talosName: talos.name,
      generatedAt: now.toISOString(),

      creditScore: Math.round(creditScore * 100) / 100,
      creditGrade,
      creditSummary: `${creditGrade} rating — ${creditScore >= 75 ? "Excellent borrowing capacity" : creditScore >= 60 ? "Good financial health" : creditScore >= 50 ? "Moderate risk profile" : "High risk — improve revenue or reduce spending"}`,

      income: {
        weeklyRevenue: rev7dNum,
        monthlyRevenue: rev30dNum,
        quarterlyRevenue: rev90dNum,
        netWeeklyIncome,
        annualizedWeeklyIncome: Math.round(annualizedWeeklyIncome * 100) / 100,
        revenueTransactionCount: {
          weekly: revenue7d.count,
          monthly: revenue30d.count,
          quarterly: revenue90d.count,
        },
      },

      debt: {
        weeklyApprovedSpending: debt7dNum,
        monthlyApprovedSpending: debt30dNum,
        quarterlyApprovedSpending: debt90dNum,
        avgMonthlySpending: Math.round(avgMonthlySpending30d * 100) / 100,
        spendingTransactionCount: {
          weekly: debt7d.count,
          monthly: debt30d.count,
          quarterly: debt90d.count,
        },
      },

      ratios: {
        debtToRevenue7d: Math.round(debtToRevenue7d * 100) / 100,
        debtToRevenue30d: Math.round(debtToRevenue30d * 100) / 100,
        debtToRevenue90d: Math.round(debtToRevenue90d * 100) / 100,
      },

      borrowingCapacity: {
        sustainableBorrowingLimit: Math.round(sustainableBorrowingLimit * 100) / 100,
        currentMonthlySpending: Math.round(avgMonthlySpending30d * 100) / 100,
        borrowingUtilization: Math.round(borrowingUtilization * 100) / 100,
        borrowingStatusMessage: borrowingUtilization > 100
          ? "⚠ Over sustainable limit — reduce spending or increase revenue"
          : borrowingUtilization > 75
          ? "⚠ High utilization — monitor closely"
          : "✓ Healthy borrowing level",
      },

      patronEngagement: {
        activePatrons: patronStats.count,
        totalPatronHoldings: Number(patronStats.totalHoldings),
      },

      riskFactors: [
        debtToRevenue30d > 80 && "High debt-to-revenue ratio",
        netWeeklyIncome < 0 && "Negative weekly cash flow",
        borrowingUtilization > 100 && "Exceeding sustainable borrowing limit",
        revenue30d.count < 5 && "Low transaction frequency",
        patronStats.count === 0 && "No patron engagement",
      ].filter(Boolean),

      recommendations: [
        netWeeklyIncome <= 0 && "Increase revenue or reduce approved spending",
        debtToRevenue30d > 60 && "Consider reducing approval threshold to control debt",
        patronStats.count < 3 && "Recruit more patrons to strengthen equity base",
        revenue30d.count < 10 && "Increase transaction frequency for stability",
        borrowingUtilization > 75 && "Plan to reduce spending or scale revenue",
      ].filter(Boolean),
    });
  } catch (err) {
    console.error("[credit-score GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
