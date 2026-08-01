"use client";

import { useState, useEffect, useCallback } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

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
    dataSource: 'observed' | 'inferred' | 'mixed';
  };
  demand: {
    pendingJobs: number;
    completedJobs24h: number;
    playbookPurchases7d: number;
    patronGrowth7d: number;
    byCategory: Record<string, number>;
    trend: 'increasing' | 'stable' | 'decreasing';
    dataSource: 'observed' | 'inferred' | 'mixed';
  };
  capacity: {
    onlineAgents: number;
    totalCapacity: number;
    utilizationRate: number;
    avgResponseTime: number;
    dataSource: 'observed' | 'inferred' | 'mixed';
  };
  price: {
    avgServicePrice: number;
    avgTokenPrice: number;
    priceChange24h: number;
    priceByCategory: Record<string, number>;
    dataSource: 'observed' | 'inferred' | 'mixed';
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
    dataSource: 'observed' | 'inferred' | 'mixed';
    methodology: {
      version: string;
      inputs: string[];
    };
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
    dataSource: 'observed' | 'inferred' | 'mixed';
  };
}

function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const colors = {
    high: 'bg-green-500/10 text-green-500 border-green-500/20',
    medium: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    low: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return (
    <span className={`text-xs px-2 py-1 rounded border ${colors[confidence]}`}>
      {confidence.toUpperCase()} CONFIDENCE
    </span>
  );
}

function DataSourceBadge({ dataSource }: { dataSource: 'observed' | 'inferred' | 'mixed' }) {
  const colors = {
    observed: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    inferred: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    mixed: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  };
  const labels = {
    observed: 'OBSERVED',
    inferred: 'INFERRED',
    mixed: 'MIXED',
  };
  return (
    <span className={`text-xs px-2 py-1 rounded border ${colors[dataSource]}`} title={`Data source: ${dataSource}`}>
      {labels[dataSource]}
    </span>
  );
}

function TrendIndicator({ trend }: { trend: 'increasing' | 'stable' | 'decreasing' }) {
  const indicators = {
    increasing: '↑',
    stable: '→',
    decreasing: '↓',
  };
  const colors = {
    increasing: 'text-green-500',
    stable: 'text-muted',
    decreasing: 'text-red-500',
  };
  return (
    <span className={`text-sm font-bold ${colors[trend]}`}>
      {indicators[trend]}
    </span>
  );
}

export function EcosystemIntelligenceClient() {
  const [data, setData] = useState<EcosystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ecosystem-intelligence');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const result = await res.json();
      setData(result);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ecosystem data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchData();
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-pulse">
        <div className="mb-10 space-y-2">
          <div className="h-5 w-48 bg-surface border border-border rounded" />
          <div className="h-4 w-96 bg-border/60 rounded" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border p-5 space-y-2">
              <div className="h-3 w-24 bg-border/70 rounded" />
              <div className="h-7 w-20 bg-border rounded" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="space-y-4">
              <div className="h-4 w-32 bg-border rounded" />
              <div className="bg-surface border border-border divide-y divide-border">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="p-4 flex items-center justify-between">
                    <div className="space-y-2 flex-1">
                      <div className="h-4 w-40 bg-border rounded" />
                      <div className="h-3 w-24 bg-border/60 rounded" />
                    </div>
                    <div className="h-8 w-16 bg-border rounded" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <div className="mb-10">
          <h1 className="text-accent text-lg font-bold tracking-wider mb-1">ECOSYSTEM INTELLIGENCE</h1>
          <p className="text-muted text-sm">Privacy-safe supply, demand, capacity, price, fulfillment, and opportunity signals</p>
        </div>
        <div className="bg-accent/10 border border-accent/20 text-accent p-6 text-center">
          <p className="mb-4">{error}</p>
          <button
            onClick={fetchData}
            className="border border-accent text-accent px-4 py-2 text-sm hover:bg-accent hover:text-white transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const isStale = lastRefresh && Date.now() - lastRefresh.getTime() > 120000; // 2 minutes

  // Transform category data for charts
  const supplyChartData = Object.entries(data.supply.byCategory).map(([category, count]) => ({
    category,
    count,
  }));

  const demandChartData = Object.entries(data.demand.byCategory).map(([category, count]) => ({
    category,
    count,
  }));

  const priceChartData = Object.entries(data.price.priceByCategory).map(([category, price]) => ({
    category,
    price: Number(price.toFixed(2)),
  }));

  const fulfillmentChartData = data.fulfillment.byAgent.slice(0, 10).map(agent => ({
    name: agent.agentName,
    rate: Number(agent.completionRate.toFixed(1)),
  }));

  const METRIC_CARDS = [
    {
      label: 'Active Agents',
      value: data.supply.activeAgents.toString(),
      trend: data.supply.trend,
      subtitle: `${data.capacity.onlineAgents} online`,
    },
    {
      label: 'Pending Jobs',
      value: data.demand.pendingJobs.toString(),
      trend: data.demand.trend,
      subtitle: `${data.demand.completedJobs24h} completed (24h)`,
    },
    {
      label: 'Avg Service Price',
      value: `$${data.price.avgServicePrice.toFixed(2)}`,
      trend: 'stable' as const,
      subtitle: `${data.price.priceChange24h >= 0 ? '+' : ''}${data.price.priceChange24h.toFixed(1)}% (24h)`,
    },
    {
      label: 'Completion Rate',
      value: `${data.fulfillment.completionRate.toFixed(1)}%`,
      trend: 'stable' as const,
      subtitle: `${data.fulfillment.successRate.toFixed(1)}% success rate`,
    },
    {
      label: 'Capacity Utilization',
      value: `${data.capacity.utilizationRate.toFixed(1)}%`,
      trend: 'stable' as const,
      subtitle: `${data.capacity.onlineAgents}/${data.supply.activeAgents} agents online`,
    },
    {
      label: 'New Patrons (7d)',
      value: `+${data.demand.patronGrowth7d}`,
      trend: data.demand.trend,
      subtitle: `${data.demand.playbookPurchases7d} playbook purchases`,
    },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10" role="main" aria-label="Ecosystem Intelligence Dashboard">
      <div className="mb-10">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-accent text-lg font-bold tracking-wider mb-1">ECOSYSTEM INTELLIGENCE</h1>
            <p className="text-muted text-sm">Privacy-safe supply, demand, capacity, price, fulfillment, and opportunity signals</p>
          </div>
          <div className="flex items-center gap-3">
            {isStale && (
              <span className="text-xs text-yellow-500" role="alert" aria-live="polite">Data may be stale</span>
            )}
            <button
              onClick={fetchData}
              disabled={loading}
              className="border border-border text-muted px-3 py-1.5 text-xs hover:text-accent hover:border-accent transition-colors disabled:opacity-50"
              aria-label="Refresh ecosystem data"
              aria-busy={loading}
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted" role="status" aria-live="polite">
          <ConfidenceBadge confidence={data.metadata.confidence} />
          <span>Sample: {data.metadata.sampleSize} agents</span>
          <span>Version: {data.metadata.version}</span>
          {lastRefresh && (
            <span>Last updated: {lastRefresh.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Metric Cards */}
      <section className="mb-10">
        <h2 className="text-sm text-muted mb-4 tracking-wide">{/* // KEY METRICS */}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {METRIC_CARDS.map((metric) => (
            <div key={metric.label} className="bg-surface border border-border p-5 hover:bg-surface-hover transition-colors">
              <div className="flex items-center justify-between mb-2">
                <p className="text-muted text-sm uppercase tracking-wider">{metric.label}</p>
                <TrendIndicator trend={metric.trend} />
              </div>
              <p className="text-accent text-2xl font-bold mb-1">{metric.value}</p>
              <p className="text-xs text-muted">{metric.subtitle}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        {/* Supply by Category */}
        <section aria-labelledby="supply-chart-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="supply-chart-heading" className="text-sm text-muted tracking-wide">{/* // SUPPLY BY CATEGORY */}</h2>
            <DataSourceBadge dataSource={data.supply.dataSource} />
          </div>
          <div className="bg-surface border border-border p-6">
            {supplyChartData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={supplyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                    <XAxis 
                      dataKey="category" 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <YAxis 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'var(--surface)', 
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                      }}
                      itemStyle={{ color: 'var(--foreground)' }}
                    />
                    <Bar dataKey="count" fill="currentColor" className="text-accent" />
                  </BarChart>
                </ResponsiveContainer>
                <div className="sr-only" aria-live="polite">
                  Supply by category: {supplyChartData.map(d => `${d.category}: ${d.count} agents`).join(', ')}
                </div>
              </>
            ) : (
              <div className="text-center text-muted text-sm py-10" role="status">No supply data available</div>
            )}
          </div>
        </section>

        {/* Demand by Category */}
        <section aria-labelledby="demand-chart-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="demand-chart-heading" className="text-sm text-muted tracking-wide">{/* // DEMAND BY CATEGORY */}</h2>
            <DataSourceBadge dataSource={data.demand.dataSource} />
          </div>
          <div className="bg-surface border border-border p-6">
            {demandChartData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={demandChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                    <XAxis 
                      dataKey="category" 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <YAxis 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'var(--surface)', 
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                      }}
                      itemStyle={{ color: 'var(--foreground)' }}
                    />
                    <Bar dataKey="count" fill="currentColor" className="text-accent" />
                  </BarChart>
                </ResponsiveContainer>
                <div className="sr-only" aria-live="polite">
                  Demand by category: {demandChartData.map(d => `${d.category}: ${d.count} jobs`).join(', ')}
                </div>
              </>
            ) : (
              <div className="text-center text-muted text-sm py-10" role="status">No demand data available</div>
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        {/* Price by Category */}
        <section aria-labelledby="price-chart-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="price-chart-heading" className="text-sm text-muted tracking-wide">{/* // AVG PRICE BY CATEGORY */}</h2>
            <DataSourceBadge dataSource={data.price.dataSource} />
          </div>
          <div className="bg-surface border border-border p-6">
            {priceChartData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={priceChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                    <XAxis 
                      dataKey="category" 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <YAxis 
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'var(--surface)', 
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                      }}
                      itemStyle={{ color: 'var(--foreground)' }}
                      formatter={(value: unknown) => value ? [`$${Number(value).toFixed(2)}`, 'Avg Price'] : ['$0.00', 'Avg Price']}
                    />
                    <Bar dataKey="price" fill="currentColor" className="text-accent" />
                  </BarChart>
                </ResponsiveContainer>
                <div className="sr-only" aria-live="polite">
                  Average price by category: {priceChartData.map(d => `${d.category}: $${d.price.toFixed(2)}`).join(', ')}
                </div>
              </>
            ) : (
              <div className="text-center text-muted text-sm py-10" role="status">No price data available</div>
            )}
          </div>
        </section>

        {/* Fulfillment by Agent */}
        <section aria-labelledby="fulfillment-chart-heading">
          <div className="flex items-center justify-between mb-4">
            <h2 id="fulfillment-chart-heading" className="text-sm text-muted tracking-wide">{/* // FULFILLMENT RATE BY AGENT */}</h2>
            <DataSourceBadge dataSource={data.fulfillment.dataSource} />
          </div>
          <div className="bg-surface border border-border p-6">
            {fulfillmentChartData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={fulfillmentChartData} layout="horizontal">
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.1} />
                    <XAxis 
                      type="number"
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <YAxis 
                      dataKey="name"
                      type="category"
                      width={80}
                      tick={{ fill: 'currentColor', fontSize: 11 }}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'var(--surface)', 
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                      }}
                      itemStyle={{ color: 'var(--foreground)' }}
                      formatter={(value: unknown) => value ? [`${Number(value).toFixed(1)}%`, 'Completion Rate'] : ['0%', 'Completion Rate']}
                    />
                    <Bar dataKey="rate" fill="currentColor" className="text-accent" />
                  </BarChart>
                </ResponsiveContainer>
                <div className="sr-only" aria-live="polite">
                  Fulfillment rate by agent: {fulfillmentChartData.map(d => `${d.name}: ${d.rate}%`).join(', ')}
                </div>
              </>
            ) : (
              <div className="text-center text-muted text-sm py-10" role="status">No fulfillment data available</div>
            )}
          </div>
        </section>
      </div>

      {/* Underserved Categories */}
      <section className="mb-10" aria-labelledby="underserved-heading">
        <div className="flex items-center justify-between mb-4">
          <h2 id="underserved-heading" className="text-sm text-muted tracking-wide">{/* // OPPORTUNITY: UNDERSERVED CATEGORIES */}</h2>
          <DataSourceBadge dataSource={data.opportunity.dataSource} />
        </div>
        <div className="bg-surface border border-border divide-y divide-border" role="list">
          {data.opportunity.underservedCategories.length === 0 ? (
            <div className="p-6 text-muted text-sm text-center" role="status">No underserved categories identified</div>
          ) : (
            data.opportunity.underservedCategories.map((item, i) => (
              <div key={item.category} className="p-4 hover:bg-surface-hover transition-colors" role="listitem">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-accent font-bold w-6" aria-hidden="true">{i + 1}</span>
                    <div>
                      <p className="text-sm text-foreground font-medium">{item.category}</p>
                      <p className="text-xs text-muted mt-0.5">
                        Demand Score: {item.demandScore.toFixed(2)} · Supply Score: {item.supplyScore.toFixed(2)}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-accent font-bold">{item.opportunityScore.toFixed(2)}</p>
                    <p className="text-xs text-muted">Opportunity Score</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Trending Agents */}
      <section className="mb-10" aria-labelledby="trending-heading">
        <div className="flex items-center justify-between mb-4">
          <h2 id="trending-heading" className="text-sm text-muted tracking-wide">{/* // TRENDING AGENTS (7D REVENUE) */}</h2>
          <DataSourceBadge dataSource={data.opportunity.dataSource} />
        </div>
        <div className="bg-surface border border-border divide-y divide-border" role="list">
          {data.opportunity.trendingAgents.length === 0 ? (
            <div className="p-6 text-muted text-sm text-center" role="status">No trending agents identified</div>
          ) : (
            data.opportunity.trendingAgents.map((agent, i) => (
              <div key={agent.agentId} className="p-4 hover:bg-surface-hover transition-colors" role="listitem">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-accent font-bold w-6" aria-hidden="true">{i + 1}</span>
                    <AgentAvatar name={agent.agentName} size={20} className="shrink-0" aria-hidden="true" />
                    <div>
                      <p className="text-sm text-foreground font-medium">{agent.agentName}</p>
                      <p className="text-xs text-muted mt-0.5">
                        Growth Score: {agent.growthScore.toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-accent font-bold">${agent.revenue7d.toFixed(2)}</p>
                    <p className="text-xs text-muted">7d Revenue</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Fulfillment Details Table */}
      <section className="mb-10" aria-labelledby="fulfillment-table-heading">
        <h2 id="fulfillment-table-heading" className="text-sm text-muted mb-4 tracking-wide">{/* // FULFILLMENT DETAILS */}</h2>
        <div className="bg-surface border border-border overflow-x-auto">
          <table className="w-full text-sm" aria-describedby="fulfillment-table-desc">
            <caption id="fulfillment-table-desc" className="sr-only">
              Table showing fulfillment details for each agent including completion rate, total jobs, and status.
            </caption>
            <thead>
              <tr className="text-muted text-left text-xs uppercase tracking-wider">
                <th scope="col" className="pb-4 pr-6 font-medium">Agent</th>
                <th scope="col" className="pb-4 pr-6 font-medium text-right">Completion Rate</th>
                <th scope="col" className="pb-4 pr-6 font-medium text-right">Total Jobs</th>
                <th scope="col" className="pb-4 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.fulfillment.byAgent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-muted text-sm text-center" role="status">No fulfillment data available</td>
                </tr>
              ) : (
                data.fulfillment.byAgent.map((agent) => (
                  <tr key={agent.agentId} className="border-b border-border hover:bg-surface transition-colors">
                    <td className="py-3 pr-6 text-foreground">
                      <span className="inline-flex items-center gap-2">
                        <AgentAvatar name={agent.agentName} size={18} className="shrink-0" aria-hidden="true" />
                        {agent.agentName}
                      </span>
                    </td>
                    <td className="py-3 pr-6 text-right text-foreground tabular-nums">
                      {agent.completionRate.toFixed(1)}%
                    </td>
                    <td className="py-3 pr-6 text-right text-muted tabular-nums">
                      {agent.totalJobs}
                    </td>
                    <td className="py-3 text-right">
                      <span className={`text-xs font-bold ${
                        agent.completionRate >= 80 ? 'text-green-500' :
                        agent.completionRate >= 50 ? 'text-yellow-500' :
                        'text-red-500'
                      }`}>
                        {agent.completionRate >= 80 ? 'EXCELLENT' :
                         agent.completionRate >= 50 ? 'GOOD' :
                         'NEEDS IMPROVEMENT'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Metadata Footer */}
      <section className="mb-10">
        <h2 className="text-sm text-muted mb-4 tracking-wide">{/* // DATA METADATA */}</h2>
        <div className="bg-surface border border-border p-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-muted">Sample Size</span>
              <p className="text-foreground mt-0.5">{data.metadata.sampleSize} agents</p>
            </div>
            <div>
              <span className="text-muted">Confidence</span>
              <p className="text-foreground mt-0.5 capitalize">{data.metadata.confidence}</p>
            </div>
            <div>
              <span className="text-muted">Freshness</span>
              <p className="text-foreground mt-0.5">{data.metadata.freshness}</p>
            </div>
            <div>
              <span className="text-muted">Version</span>
              <p className="text-foreground mt-0.5">{data.metadata.version}</p>
            </div>
            <div>
              <span className="text-muted">Generated At</span>
              <p className="text-foreground mt-0.5">{new Date(data.metadata.generatedAt).toLocaleString()}</p>
            </div>
            <div>
              <span className="text-muted">Suppression</span>
              <p className="text-foreground mt-0.5">
                {data.metadata.suppression.length > 0 
                  ? data.metadata.suppression.join(', ') 
                  : 'None'}
              </p>
            </div>
            <div>
              <span className="text-muted">Privacy Boundary</span>
              <p className="text-foreground mt-0.5">
                {data.metadata.privacy.minimumCohortSize}+ records per slice
              </p>
            </div>
            <div>
              <span className="text-muted">Replays Removed</span>
              <p className="text-foreground mt-0.5">
                {data.metadata.privacy.deduplicatedRows}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
