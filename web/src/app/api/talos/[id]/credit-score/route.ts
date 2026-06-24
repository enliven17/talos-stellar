import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsRevenues, tlsCommerceJobs, tlsApprovals } from "@/db/schema";
import { eq, gte, and } from "drizzle-orm";

// GET /api/talos/:id/credit-score — Calculate credit score for a Talos
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const talosId = params.id;

    // Fetch talos and verify it exists
    const talos = await db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.id, talosId),
    });

    if (!talos) {
      return Response.json({ error: "Talos not found" }, { status: 404 });
    }

    // Get date ranges for analysis
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
    const thirteenWeeksAgo = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);

    // Fetch revenue data
    const allRevenues = await db
      .select({
        amount: tlsRevenues.amount,
        createdAt: tlsRevenues.createdAt,
      })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, talosId));

    // Fetch approved spending (from approvals)
    const approvedSpending = await db
      .select({
        amount: tlsApprovals.amount,
        createdAt: tlsApprovals.createdAt,
      })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, talosId),
          eq(tlsApprovals.status, "approved")
        )
      );

    // Fetch commerce job spending
    const commerceSpending = await db
      .select({
        amount: tlsCommerceJobs.amount,
        createdAt: tlsCommerceJobs.createdAt,
      })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, talosId),
          eq(tlsCommerceJobs.status, "completed")
        )
      );

    // Calculate metrics
    const totalRevenue = allRevenues.reduce(
      (sum, r) => sum + parseFloat(r.amount.toString()),
      0
    );

    const weeklyRevenue = allRevenues
      .filter((r) => r.createdAt >= oneWeekAgo)
      .reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);

    const fourWeekRevenue = allRevenues
      .filter((r) => r.createdAt >= fourWeeksAgo)
      .reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);

    const totalSpending =
      approvedSpending.reduce((sum, a) => sum + parseFloat(a.amount?.toString() || "0"), 0) +
      commerceSpending.reduce((sum, c) => sum + parseFloat(c.amount.toString()), 0);

    const approvedSpendingThisMonth = approvedSpending
      .filter((a) => a.createdAt >= fourWeeksAgo)
      .reduce((sum, a) => sum + parseFloat(a.amount?.toString() || "0"), 0);

    const commerceSpendingThisMonth = commerceSpending
      .filter((c) => c.createdAt >= fourWeeksAgo)
      .reduce((sum, c) => sum + parseFloat(c.amount.toString()), 0);

    const totalSpendingThisMonth = approvedSpendingThisMonth + commerceSpendingThisMonth;

    // Calculate debt-to-revenue ratio (lower is better)
    // If no revenue yet, use pending score
    const debtToRevenueRatio = totalRevenue > 0 ? totalSpending / totalRevenue : 0;

    // Calculate net weekly income
    // Estimate based on recent data
    const historicalWeeks = allRevenues.length > 0 ? 4 : 1; // Use 4 weeks if we have data
    const netWeeklyIncome = fourWeekRevenue / historicalWeeks - totalSpendingThisMonth / historicalWeeks;

    // Determine active borrowing limit
    // Based on historical revenue and stability
    // Conservative: 30% of average monthly revenue
    const avgMonthlyRevenue = fourWeekRevenue;
    const activeBorrowingLimit = Math.max(0, avgMonthlyRevenue * 0.3);

    // Calculate credit score (0-850 scale, similar to real credit scoring)
    let creditScore = 300; // Floor score

    // Revenue factor (max 200 points)
    if (totalRevenue > 1000) creditScore += 150;
    else if (totalRevenue > 100) creditScore += 100;
    else if (totalRevenue > 0) creditScore += 50;

    // Debt-to-revenue ratio factor (max 250 points)
    if (debtToRevenueRatio < 0.1) creditScore += 250; // Excellent
    else if (debtToRevenueRatio < 0.3) creditScore += 200;
    else if (debtToRevenueRatio < 0.5) creditScore += 150;
    else if (debtToRevenueRatio < 1.0) creditScore += 75;
    else creditScore += 0; // Poor

    // Payment history factor (max 200 points)
    // Count on-time vs late approvals
    const onTimeApprovals = approvedSpending.filter(
      (a) => a.createdAt >= thirteenWeeksAgo
    ).length;
    if (onTimeApprovals >= 10) creditScore += 200;
    else if (onTimeApprovals >= 5) creditScore += 150;
    else if (onTimeApprovals >= 1) creditScore += 100;

    // Clamp between 300-850
    creditScore = Math.min(850, Math.max(300, creditScore));

    // Calculate credit grade
    const grade =
      creditScore >= 750 ? "A" :
      creditScore >= 700 ? "B+" :
      creditScore >= 650 ? "B" :
      creditScore >= 600 ? "C+" :
      creditScore >= 550 ? "C" :
      creditScore >= 500 ? "D" :
      "F";

    return Response.json({
      talosId,
      creditScore,
      grade,
      financialMetrics: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        weeklyRevenue: parseFloat(weeklyRevenue.toFixed(2)),
        fourWeekRevenue: parseFloat(fourWeekRevenue.toFixed(2)),
        totalSpending: parseFloat(totalSpending.toFixed(2)),
        monthlySpending: parseFloat(totalSpendingThisMonth.toFixed(2)),
      },
      debtToRevenueRatio: parseFloat(debtToRevenueRatio.toFixed(4)),
      netWeeklyIncome: parseFloat(netWeeklyIncome.toFixed(2)),
      activeBorrowingLimit: parseFloat(activeBorrowingLimit.toFixed(2)),
      riskAssessment: {
        paymentHistory: onTimeApprovals,
        recentTransactions: approvedSpending.filter(
          (a) => a.createdAt >= fourWeeksAgo
        ).length,
      },
    });
  } catch (error) {
    console.error("GET /api/talos/:id/credit-score error:", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
