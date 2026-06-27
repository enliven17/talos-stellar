import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsRevenues, tlsActivities, tlsPatrons } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { analyzeWithGPT } from "@/lib/fulfillment/clients";
import { verifyAgentApiKey } from "@/lib/auth";

interface FinancialProjection {
  expectedRevenue: {
    monthly: number[];
    quarterly: number[];
    yearly: number;
  };
  budgetSuggestions: {
    category: string;
    amount: number;
    rationale: string;
  }[];
  roiEstimations: {
    shortTerm: number; // 3 months
    mediumTerm: number; // 6 months
    longTerm: number; // 12 months
    confidence: "low" | "medium" | "high";
  };
  insights: string[];
}

// GET /api/talos/:id/financial-projection - AI-driven financial projections
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    // Fetch TALOS basic info
    const talos = await db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.id, id),
    });

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Fetch historical revenue data (last 90 days)
    const revenues = await db
      .select()
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id))
      .orderBy(desc(tlsRevenues.createdAt))
      .limit(100);

    // Fetch recent activities for context
    const activities = await db
      .select()
      .from(tlsActivities)
      .where(eq(tlsActivities.talosId, id))
      .orderBy(desc(tlsActivities.createdAt))
      .limit(50);

    // Fetch patron information
    const patrons = await db
      .select()
      .from(tlsPatrons)
      .where(eq(tlsPatrons.talosId, id));

    // Calculate revenue summary
    const totalRevenue = revenues.reduce(
      (sum, r) => sum + parseFloat(r.amount || "0"),
      0
    );

    const revenueBySource = revenues.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + parseFloat(r.amount || "0");
      return acc;
    }, {} as Record<string, number>);

    const totalPatronPulse = patrons.reduce(
      (sum, p) => sum + p.pulseAmount,
      0
    );

    // Prepare historical summary for LLM
    const historicalSummary = {
      talos: {
        name: talos.name,
        category: talos.category,
        description: talos.description,
        gtmBudget: parseFloat(talos.gtmBudget || "0"),
        totalSupply: talos.totalSupply,
        pulsePrice: parseFloat(talos.pulsePrice || "0"),
        creatorShare: talos.creatorShare,
        investorShare: talos.investorShare,
        treasuryShare: talos.treasuryShare,
      },
      financials: {
        totalRevenue,
        revenueBySource,
        revenueCount: revenues.length,
        averageRevenuePerTransaction: revenues.length > 0 ? totalRevenue / revenues.length : 0,
      },
      patrons: {
        totalCount: patrons.length,
        totalPulse: totalPatronPulse,
        roles: patrons.reduce((acc, p) => {
          acc[p.role] = (acc[p.role] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      activities: {
        totalCount: activities.length,
        types: activities.reduce((acc, a) => {
          acc[a.type] = (acc[a.type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        recentActivity: activities.slice(0, 10).map((a) => ({
          type: a.type,
          content: a.content,
          channel: a.channel,
          status: a.status,
          createdAt: a.createdAt,
        })),
      },
    };

    // Prepare LLM prompt
    const systemPrompt = `You are a financial analyst specializing in AI agent corporations and decentralized autonomous organizations. 
Analyze the provided historical data and generate financial projections in JSON format.

Your response must be a valid JSON object with the following structure:
{
  "expectedRevenue": {
    "monthly": [number, number, number, number, number, number], // next 6 months
    "quarterly": [number, number, number], // next 3 quarters
    "yearly": number // next 12 months total
  },
  "budgetSuggestions": [
    {
      "category": "string",
      "amount": number,
      "rationale": "string"
    }
  ],
  "roiEstimations": {
    "shortTerm": number, // percentage for 3 months
    "mediumTerm": number, // percentage for 6 months
    "longTerm": number, // percentage for 12 months
    "confidence": "low" | "medium" | "high"
  },
  "insights": ["string", "string", "string"]
}

Base your projections on:
- Historical revenue trends and patterns
- Activity levels and engagement
- Patron growth and token economics
- Market category and GTM budget
- Revenue source diversity

Be realistic but optimistic. Use the current GTM budget as a baseline for budget suggestions.`;

    const userPrompt = `Analyze this TALOS agent corporation and provide financial projections:

${JSON.stringify(historicalSummary, null, 2)}

Current date: ${new Date().toISOString()}

Generate projections for the next 12 months.`;

    // Call LLM for projections
    const llmResponse = await analyzeWithGPT(systemPrompt, userPrompt);

    // Parse and validate response
    let projection: FinancialProjection;
    try {
      projection = JSON.parse(llmResponse) as FinancialProjection;
    } catch {
      // Fallback if LLM returns invalid JSON
      projection = {
        expectedRevenue: {
          monthly: [0, 0, 0, 0, 0, 0],
          quarterly: [0, 0, 0],
          yearly: 0,
        },
        budgetSuggestions: [
          {
            category: "Marketing",
            amount: talos.gtmBudget ? parseFloat(talos.gtmBudget) * 0.4 : 80,
            rationale: "Based on GTM budget allocation",
          },
          {
            category: "Operations",
            amount: talos.gtmBudget ? parseFloat(talos.gtmBudget) * 0.3 : 60,
            rationale: "Operational expenses",
          },
          {
            category: "Development",
            amount: talos.gtmBudget ? parseFloat(talos.gtmBudget) * 0.3 : 60,
            rationale: "Feature development and improvements",
          },
        ],
        roiEstimations: {
          shortTerm: 5,
          mediumTerm: 15,
          longTerm: 30,
          confidence: "low",
        },
        insights: [
          "Insufficient historical data for accurate projections",
          "Consider increasing activity levels to improve revenue",
          "Focus on patron acquisition for long-term growth",
        ],
      };
    }

    // Return projection with metadata
    return Response.json({
      projection,
      metadata: {
        talosId: id,
        generatedAt: new Date().toISOString(),
        dataPoints: {
          revenues: revenues.length,
          activities: activities.length,
          patrons: patrons.length,
        },
      },
    });
  } catch (error) {
    console.error("Financial projection error:", error);
    return Response.json(
      { error: "Internal server error", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
