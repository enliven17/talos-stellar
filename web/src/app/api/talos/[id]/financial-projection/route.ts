import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsRevenues } from "@/db/schema";
import { desc, eq, and, gte } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/financial-projection — Get financial projection data
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
        gtmBudget: tlsTalos.gtmBudget,
        createdAt: tlsTalos.createdAt
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Get revenue data for the last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const revenues = await db
      .select({
        amount: tlsRevenues.amount,
        currency: tlsRevenues.currency,
        source: tlsRevenues.source,
        createdAt: tlsRevenues.createdAt,
      })
      .from(tlsRevenues)
      .where(and(eq(tlsRevenues.talosId, id), gte(tlsRevenues.createdAt, twelveMonthsAgo)))
      .orderBy(desc(tlsRevenues.createdAt));

    // Generate monthly revenue data
    const monthlyData = [];
    const now = new Date();
    
    for (let i = 11; i >= 0; i--) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = monthDate.toLocaleString('default', { month: 'short', year: '2-digit' });
      
      // Calculate actual revenue for this month
      const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
      const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
      
      const actualRevenue = revenues
        .filter(r => {
          const date = new Date(r.createdAt);
          return date >= monthStart && date <= monthEnd;
        })
        .reduce((sum, r) => sum + parseFloat(r.amount), 0);

      // Generate AI-projected revenue (simple projection based on growth trend)
      // For demo purposes, we'll project a 10% month-over-month growth
      const projectedRevenue = actualRevenue > 0 
        ? actualRevenue * (1 + (i * 0.1)) 
        : (talos.gtmBudget ? parseFloat(talos.gtmBudget) * 0.5 : 1000) * (1 + (i * 0.1));

      monthlyData.push({
        month: monthStr,
        actualRevenue: Math.round(actualRevenue * 100) / 100,
        projectedRevenue: Math.round(projectedRevenue * 100) / 100,
        budgetTarget: talos.gtmBudget ? parseFloat(talos.gtmBudget) : 2000,
      });
    }

    // Calculate budget targets (monthly GTM budget)
    const budgetTarget = talos.gtmBudget ? parseFloat(talos.gtmBudget) : 2000;

    return Response.json({
      talos: {
        id: talos.id,
        name: talos.name,
        budgetTarget,
      },
      monthlyData,
      revenueBySource: revenues.reduce((acc, r) => {
        const source = r.source;
        acc[source] = (acc[source] || 0) + parseFloat(r.amount);
        return acc;
      }, {} as Record<string, number>),
    });
  } catch (error) {
    console.error('Financial projection error:', error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
