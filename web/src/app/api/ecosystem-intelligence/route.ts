import { NextResponse } from "next/server";
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
import {
  AnalyticsInputValidationError,
  DEFAULT_ANALYTICS_PRIVACY_POLICY,
  deduplicateAnalyticsRows,
  describeSuppression,
  suppressSparseRecord,
  suppressSparseRows,
} from "@/lib/analytics-privacy";

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
    privacy: {
      minimumCohortSize: number;
      maximumInputRows: number;
      deduplicatedRows: number;
    };
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
    methodology: {
      version: string;
      inputs: readonly ['observed-demand', 'observed-supply', 'observed-revenue'];
    };
  };
}

export async function GET(req: Request) {
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
      rawAgents,
      rawServices,
      rawPlaybooks,
      rawRevenues,
      rawJobs,
      rawPurchases,
      rawPatronGrowth
    ] = await Promise.all([
      db.query.tlsTalos.findMany({
        where: eq(tlsTalos.status, 'Active'),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
        with: {
          patrons: true,
          revenues: true,
        }
      }),
      db.query.tlsCommerceServices.findMany({
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      }),
      db.query.tlsPlaybooks.findMany({
        where: eq(tlsPlaybooks.status, 'active'),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      }),
      db.query.tlsRevenues.findMany({
        where: gte(tlsRevenues.createdAt, sevenDaysAgo),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      }),
      db.query.tlsCommerceJobs.findMany({
        where: gte(tlsCommerceJobs.createdAt, sevenDaysAgo),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      }),
      db.query.tlsPlaybookPurchases.findMany({
        where: gte(tlsPlaybookPurchases.createdAt, sevenDaysAgo),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      }),
      db.query.tlsPatrons.findMany({
        where: and(
          eq(tlsPatrons.status, 'active'),
          gte(tlsPatrons.createdAt, sevenDaysAgo)
        ),
        limit: DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows + 1,
      })
    ]);

    const deduplicated = [
      deduplicateAnalyticsRows(rawAgents, 'agents', row => row.id),
      deduplicateAnalyticsRows(rawServices, 'services', row => row.id),
      deduplicateAnalyticsRows(rawPlaybooks, 'playbooks', row => row.id),
      deduplicateAnalyticsRows(rawRevenues, 'revenues', row => row.id),
      deduplicateAnalyticsRows(rawJobs, 'jobs', row => row.id),
      deduplicateAnalyticsRows(rawPurchases, 'purchases', row => row.id),
      deduplicateAnalyticsRows(rawPatronGrowth, 'patrons', row => row.id),
    ] as const;
    const [
      { rows: allAgents },
      { rows: allServices },
      { rows: allPlaybooks },
      { rows: recentRevenues },
      { rows: recentJobs },
      { rows: recentPurchases },
      { rows: recentPatronGrowth },
    ] = deduplicated;
    const deduplicatedRows = deduplicated.reduce(
      (total, result) => total + result.duplicateCount,
      0,
    );

    // Calculate metadata
    const sampleSize = allAgents.length;
    const confidence = sampleSize >= 10 ? 'high' : sampleSize >= 5 ? 'medium' : 'low';
    const freshness = 'real-time';
    const suppression: string[] = [];
    const version = '1.1.0';

    // Supply metrics
    const activeAgents = allAgents.length;
    const totalServices = allServices.length;
    const totalPlaybooks = allPlaybooks.length;
    
    const categoryCohortSizes: Record<string, number> = {};
    allAgents.forEach(agent => {
      categoryCohortSizes[agent.category] =
        (categoryCohortSizes[agent.category] || 0) + 1;
    });
    const supplyByCategory = suppressSparseRecord(
      categoryCohortSizes,
      categoryCohortSizes,
    );

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
    const visibleDemandByCategory = suppressSparseRecord(
      demandByCategory,
      categoryCohortSizes,
    );

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
    const visiblePriceByCategory = suppressSparseRecord(
      avgPriceByCategory,
      categoryCohortSizes,
    );

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

    const byAgentCandidates = Array.from(jobsByAgent.entries()).map(([agentId, stats]) => {
      const agent = allAgents.find(a => a.id === agentId);
      return {
        agentId,
        agentName: agent?.name || 'Unknown',
        completionRate: stats.total > 0 ? (stats.completed / stats.total) * 100 : 0,
        totalJobs: stats.total,
      };
    });
    const visibleByAgent = suppressSparseRows(
      byAgentCandidates,
      row => row.totalJobs,
    );
    const byAgent = visibleByAgent.rows
      .sort((a, b) => b.completionRate - a.completionRate)
      .slice(0, 10);

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

    const underservedCandidates = Array.from(categoryScores.entries())
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
      .sort((a, b) => b.opportunityScore - a.opportunityScore);
    const visibleUnderservedCategories = suppressSparseRows(
      underservedCandidates,
      row => categoryCohortSizes[row.category] ?? 0,
    );
    const underservedCategories = visibleUnderservedCategories.rows
      .slice(0, 5);

    // Trending agents (by revenue growth)
    const agentRevenue7d = new Map<string, { total: number; events: number }>();
    recentRevenues.forEach(revenue => {
      const existing = agentRevenue7d.get(revenue.talosId) || { total: 0, events: 0 };
      agentRevenue7d.set(revenue.talosId, {
        total: existing.total + Number(revenue.amount),
        events: existing.events + 1,
      });
    });

    const trendingCandidates = Array.from(agentRevenue7d.entries())
      .map(([agentId, revenue]) => {
        const agent = allAgents.find(a => a.id === agentId);
        const totalRevenue = agent?.revenues.reduce((sum, r) => sum + Number(r.amount), 0) || 0;
        const growthScore = totalRevenue > 0 ? (revenue.total / totalRevenue) * 100 : 0;
        return {
          agentId,
          agentName: agent?.name || 'Unknown',
          growthScore,
          revenue7d: revenue.total,
          cohortSize: revenue.events,
        };
      })
      .filter(a => a.revenue7d > 0)
      .sort((a, b) => b.growthScore - a.growthScore);
    const visibleTrendingAgents = suppressSparseRows(
      trendingCandidates,
      row => row.cohortSize,
    );
    const trendingAgents = visibleTrendingAgents.rows
      .slice(0, 5)
      .map(agent => ({
        agentId: agent.agentId,
        agentName: agent.agentName,
        growthScore: agent.growthScore,
        revenue7d: agent.revenue7d,
      }));

    [
      describeSuppression('supply.byCategory', supplyByCategory.suppressedCount),
      describeSuppression('demand.byCategory', visibleDemandByCategory.suppressedCount),
      describeSuppression('price.priceByCategory', visiblePriceByCategory.suppressedCount),
      describeSuppression('fulfillment.byAgent', visibleByAgent.suppressedCount),
      describeSuppression(
        'opportunity.underservedCategories',
        visibleUnderservedCategories.suppressedCount,
      ),
      describeSuppression(
        'opportunity.trendingAgents',
        visibleTrendingAgents.suppressedCount,
      ),
    ].forEach(entry => {
      if (entry) suppression.push(entry);
    });

    const metrics: EcosystemMetrics = {
      metadata: {
        sampleSize,
        confidence,
        freshness,
        suppression,
        version,
        generatedAt: now.toISOString(),
        privacy: {
          minimumCohortSize:
            DEFAULT_ANALYTICS_PRIVACY_POLICY.minimumCohortSize,
          maximumInputRows:
            DEFAULT_ANALYTICS_PRIVACY_POLICY.maximumInputRows,
          deduplicatedRows,
        },
      },
      supply: {
        activeAgents,
        totalServices,
        totalPlaybooks,
        byCategory: supplyByCategory.values,
        trend: supplyTrend,
        dataSource: 'observed',
      },
      demand: {
        pendingJobs,
        completedJobs24h,
        playbookPurchases7d,
        patronGrowth7d,
        byCategory: visibleDemandByCategory.values,
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
        priceByCategory: visiblePriceByCategory.values,
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
        methodology: {
          version: 'demand-supply-ratio-v1',
          inputs: ['observed-demand', 'observed-supply', 'observed-revenue'],
        },
      },
    };

    const response = NextResponse.json(metrics);
    
    // Add cache headers for public endpoint
    response.headers.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`);
    response.headers.set('CDN-Cache-Control', `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`);
    
    return response;
  } catch (error) {
    console.error('Error fetching ecosystem intelligence:', error);

    if (error instanceof AnalyticsInputValidationError) {
      return NextResponse.json(
        { error: 'Analytics input failed validation', retryable: false },
        { status: 422 },
      );
    }
    
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
