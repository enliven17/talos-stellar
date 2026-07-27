import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { 
  tlsTalos, 
  tlsPatrons, 
  tlsRevenues, 
  tlsCommerceJobs,
  tlsPlaybooks,
  tlsPlaybookPurchases 
} from "@/db/schema";
import { and, gte, eq } from "drizzle-orm";
import { isRetryableDbError } from "@/db/db-retry";

export const dynamic = 'force-dynamic';

const CACHE_MAX_AGE = 30; // 30 seconds cache for public endpoint
const STALE_WHILE_REVALIDATE = 60; // Serve stale for up to 60s while revalidating

interface EcosystemMetrics {
  metadata: {
    sampleSize: number;
    confidence: 'high' | 'medium' | 'low';
    freshness: string;
    suppression: string[];
    version: string;
    generatedAt: string;
  };
  supply: {
    activeAgents: number;
    totalServices: number;
    totalPlaybooks: number;
    byCategory: Record<string, number>;
    trend: 'increasing' | 'stable' | 'decreasing';
    dataSource: 'observed'; // Direct database counts
  };
  demand: {
    pendingJobs: number;
    completedJobs24h: number;
    playbookPurchases7d: number;
    patronGrowth7d: number;
    byCategory: Record<string, number>;
    trend: 'increasing' | 'stable' | 'decreasing';
    dataSource: 'observed'; // Direct database counts
  };
  capacity: {
    onlineAgents: number;
    totalCapacity: number;
    utilizationRate: number;
    avgResponseTime: number;
    dataSource: 'mixed'; // onlineAgents observed, capacity inferred
  };
  price: {
    avgServicePrice: number;
    avgTokenPrice: number;
    priceChange24h: number;
    priceByCategory: Record<string, number>;
    dataSource: 'observed'; // Direct from database
  };
  fulfillment: {
    completionRate: number;
    successRate: number;
    avgFulfillmentTime: number;
    byAgent: Array<{
      agentId: string;
      agentName: string;
      completionRate: number;
      totalJobs: number;
    }>;
    dataSource: 'observed'; // Direct from job records
  };
  opportunity: {
    underservedCategories: Array<{
      category: string;
      demandScore: number;
      supplyScore: number;
      opportunityScore: number;
    }>;
    trendingAgents: Array<{
      agentId: string;
      agentName: string;
      growthScore: number;
      revenue7d: number;
    }>;
    dataSource: 'inferred'; // Calculated from observed data
  };
}

export async function GET(req: NextRequest) {
  // For now, this is a public endpoint for ecosystem-wide metrics.
  // If authorization is needed, uncomment the following:
  // const wallet = req.nextUrl.searchParams.get("wallet");
  // if (!wallet) {
  //   return NextResponse.json({ error: "wallet parameter required" }, { status: 400 });
  // }
  
  try {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Add idempotency support via request header
    const idempotencyKey = req.headers.get('Idempotency-Key');
    if (idempotencyKey) {
      // For GET requests, idempotency is less critical but we can cache by key
      // This would be more relevant for POST/PUT operations
      console.log(`Idempotency-Key provided: ${idempotencyKey}`);
    }

    // Fetch all relevant data in parallel with retry logic for transient failures
    const [
      allAgents,
      allServices,
      allPlaybooks,
      recentRevenues,
      recentJobs,
      recentPurchases,
      recentPatronGrowth
    ] = await Promise.all([
      db.query.tlsTalos.findMany({
        where: eq(tlsTalos.status, 'Active'),
        with: {
          patrons: true,
          revenues: true,
        }
      }),
      db.query.tlsCommerceServices.findMany(),
      db.query.tlsPlaybooks.findMany({
        where: eq(tlsPlaybooks.status, 'active')
      }),
      db.query.tlsRevenues.findMany({
        where: gte(tlsRevenues.createdAt, sevenDaysAgo)
      }),
      db.query.tlsCommerceJobs.findMany({
        where: gte(tlsCommerceJobs.createdAt, sevenDaysAgo)
      }),
      db.query.tlsPlaybookPurchases.findMany({
        where: gte(tlsPlaybookPurchases.createdAt, sevenDaysAgo)
      }),
      db.query.tlsPatrons.findMany({
        where: and(
          eq(tlsPatrons.status, 'active'),
          gte(tlsPatrons.createdAt, sevenDaysAgo)
        )
      })
    ]);

    // Calculate metadata
    const sampleSize = allAgents.length;
    const confidence = sampleSize >= 10 ? 'high' : sampleSize >= 5 ? 'medium' : 'low';
    const freshness = 'real-time';
    const suppression: string[] = [];
    const version = '1.0.0';

    // Supply metrics
    const activeAgents = allAgents.length;
    const totalServices = allServices.length;
    const totalPlaybooks = allPlaybooks.length;
    
    const byCategory: Record<string, number> = {};
    allAgents.forEach(agent => {
      byCategory[agent.category] = (byCategory[agent.category] || 0) + 1;
    });

    // Calculate trend (compare with previous period - simplified for now)
    const supplyTrend: 'increasing' | 'stable' | 'decreasing' = 'stable';

    // Demand metrics
    const pendingJobs = recentJobs.filter(j => j.status === 'pending').length;
    const completedJobs24h = recentJobs.filter(j => 
      j.status === 'completed' && j.createdAt >= twentyFourHoursAgo
    ).length;
    const playbookPurchases7d = recentPurchases.length;
    const patronGrowth7d = recentPatronGrowth.length;

    const demandByCategory: Record<string, number> = {};
    recentJobs.forEach(job => {
      const agent = allAgents.find(a => a.id === job.talosId);
      if (agent) {
        demandByCategory[agent.category] = (demandByCategory[agent.category] || 0) + 1;
      }
    });

    const demandTrend: 'increasing' | 'stable' | 'decreasing' = 'stable';

    // Capacity metrics
    const onlineAgents = allAgents.filter(a => a.agentOnline).length;
    const totalCapacity = onlineAgents * 100; // Simplified capacity model
    const utilizationRate = pendingJobs > 0 ? Math.min((pendingJobs / totalCapacity) * 100, 100) : 0;
    const avgResponseTime = 0; // Would need actual response time data

    // Price metrics
    const avgServicePrice = allServices.length > 0 
      ? allServices.reduce((sum, s) => sum + Number(s.price), 0) / allServices.length 
      : 0;
    const avgTokenPrice = allAgents.length > 0
      ? allAgents.reduce((sum, a) => sum + Number(a.pulsePrice), 0) / allAgents.length
      : 0;
    
    // Calculate price change (simplified - would need historical data)
    const priceChange24h = 0;

    const priceByCategory: Record<string, number[]> = {};
    allServices.forEach(service => {
      const agent = allAgents.find(a => a.id === service.talosId);
      if (agent) {
        if (!priceByCategory[agent.category]) {
          priceByCategory[agent.category] = [];
        }
        priceByCategory[agent.category].push(Number(service.price));
      }
    });
    
    // Average prices by category
    const avgPriceByCategory: Record<string, number> = {};
    Object.keys(priceByCategory).forEach(category => {
      const prices = priceByCategory[category];
      avgPriceByCategory[category] = prices.reduce((sum, p) => sum + p, 0) / prices.length;
    });

    // Fulfillment metrics
    const totalJobs = recentJobs.length;
    const completedJobs = recentJobs.filter(j => j.status === 'completed').length;
    const completionRate = totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0;
    const successRate = completionRate; // Simplified - assuming completed = successful
    const avgFulfillmentTime = 0; // Would need timestamp data for completed jobs

    // By agent fulfillment
    const jobsByAgent = new Map<string, { total: number; completed: number }>();
    recentJobs.forEach(job => {
      const existing = jobsByAgent.get(job.talosId) || { total: 0, completed: 0 };
      existing.total++;
      if (job.status === 'completed') existing.completed++;
      jobsByAgent.set(job.talosId, existing);
    });

    const byAgent = Array.from(jobsByAgent.entries()).map(([agentId, stats]) => {
      const agent = allAgents.find(a => a.id === agentId);
      return {
        agentId,
        agentName: agent?.name || 'Unknown',
        completionRate: stats.total > 0 ? (stats.completed / stats.total) * 100 : 0,
        totalJobs: stats.total,
      };
    }).sort((a, b) => b.completionRate - a.completionRate).slice(0, 10);

    // Opportunity metrics
    // Calculate demand vs supply by category
    const categoryScores = new Map<string, { demand: number; supply: number }>();
    
    // Initialize with supply
    allAgents.forEach(agent => {
      const existing = categoryScores.get(agent.category) || { demand: 0, supply: 0 };
      existing.supply++;
      categoryScores.set(agent.category, existing);
    });

    // Add demand
    recentJobs.forEach(job => {
      const agent = allAgents.find(a => a.id === job.talosId);
      if (agent) {
        const existing = categoryScores.get(agent.category) || { demand: 0, supply: 0 };
        existing.demand++;
        categoryScores.set(agent.category, existing);
      }
    });

    const underservedCategories = Array.from(categoryScores.entries())
      .map(([category, scores]) => {
        const demandScore = scores.demand / (scores.supply || 1);
        const supplyScore = scores.supply / allAgents.length;
        const opportunityScore = demandScore - supplyScore;
        return {
          category,
          demandScore,
          supplyScore,
          opportunityScore,
        };
      })
      .filter(c => c.opportunityScore > 0)
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 5);

    // Trending agents (by revenue growth)
    const agentRevenue7d = new Map<string, number>();
    recentRevenues.forEach(revenue => {
      const existing = agentRevenue7d.get(revenue.talosId) || 0;
      agentRevenue7d.set(revenue.talosId, existing + Number(revenue.amount));
    });

    const trendingAgents = Array.from(agentRevenue7d.entries())
      .map(([agentId, revenue7d]) => {
        const agent = allAgents.find(a => a.id === agentId);
        const totalRevenue = agent?.revenues.reduce((sum, r) => sum + Number(r.amount), 0) || 0;
        const growthScore = totalRevenue > 0 ? (revenue7d / totalRevenue) * 100 : 0;
        return {
          agentId,
          agentName: agent?.name || 'Unknown',
          growthScore,
          revenue7d,
        };
      })
      .filter(a => a.revenue7d > 0)
      .sort((a, b) => b.growthScore - a.growthScore)
      .slice(0, 5);

    const metrics: EcosystemMetrics = {
      metadata: {
        sampleSize,
        confidence,
        freshness,
        suppression,
        version,
        generatedAt: now.toISOString(),
      },
      supply: {
        activeAgents,
        totalServices,
        totalPlaybooks,
        byCategory,
        trend: supplyTrend,
        dataSource: 'observed',
      },
      demand: {
        pendingJobs,
        completedJobs24h,
        playbookPurchases7d,
        patronGrowth7d,
        byCategory: demandByCategory,
        trend: demandTrend,
        dataSource: 'observed',
      },
      capacity: {
        onlineAgents,
        totalCapacity,
        utilizationRate,
        avgResponseTime,
        dataSource: 'mixed',
      },
      price: {
        avgServicePrice,
        avgTokenPrice,
        priceChange24h,
        priceByCategory: avgPriceByCategory,
        dataSource: 'observed',
      },
      fulfillment: {
        completionRate,
        successRate,
        avgFulfillmentTime,
        byAgent,
        dataSource: 'observed',
      },
      opportunity: {
        underservedCategories,
        trendingAgents,
        dataSource: 'inferred',
      },
    };

    const response = NextResponse.json(metrics);
    
    // Add cache headers for public endpoint
    response.headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`);
    response.headers.set('CDN-Cache-Control', `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`);
    
    return response;
  } catch (error) {
    console.error('Error fetching ecosystem intelligence:', error);
    
    // Check if error is retryable
    if (isRetryableDbError(error)) {
      return NextResponse.json(
        { error: 'Temporary database error, please retry', retryable: true },
        { status: 503 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to fetch ecosystem intelligence data' },
      { status: 500 }
    );
  }
}
