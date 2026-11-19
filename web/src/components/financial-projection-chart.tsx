"use client";

import { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export interface FinancialProjectionData {
  projection: {
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
      shortTerm: number;
      mediumTerm: number;
      longTerm: number;
      confidence: "low" | "medium" | "high";
    };
    insights: string[];
  };
}

export interface FinancialProjectionChartProps {
  talosId: string;
  initialData?: FinancialProjectionData;
}

export function getRevenueTrendSummary(monthly: number[]): string {
  if (!monthly || monthly.length === 0) {
    return "No projected revenue data available.";
  }
  const first = monthly[0] ?? 0;
  const last = monthly[monthly.length - 1] ?? 0;
  const firstMonth = "M1";
  const lastMonth = `M${monthly.length}`;
  if (last > first) {
    return `Projected revenue trends upward from $${first.toFixed(2)} in ${firstMonth} to $${last.toFixed(2)} in ${lastMonth}.`;
  }
  if (last < first) {
    return `Projected revenue trends downward from $${first.toFixed(2)} in ${firstMonth} to $${last.toFixed(2)} in ${lastMonth}.`;
  }
  return `Projected revenue remains steady at $${first.toFixed(2)} from ${firstMonth} to ${lastMonth}.`;
}

export function getBudgetTrendSummary(
  suggestions: { category: string; amount: number }[]
): string {
  if (!suggestions || suggestions.length === 0) {
    return "No budget suggestions available.";
  }
  const total = suggestions.reduce((acc, curr) => acc + (curr.amount ?? 0), 0);
  const highest = suggestions.reduce(
    (max, curr) => (curr.amount > max.amount ? curr : max),
    suggestions[0]
  );
  return `Budget suggestions across ${suggestions.length} categories totalling $${total.toFixed(2)}, with highest allocation in ${highest.category} at $${highest.amount.toFixed(2)}.`;
}

export function FinancialProjectionChart({
  talosId,
  initialData,
}: FinancialProjectionChartProps) {
  const [data, setData] = useState<FinancialProjectionData | null>(
    initialData ?? null
  );
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [showRevenueTable, setShowRevenueTable] = useState(false);
  const [showBudgetTable, setShowBudgetTable] = useState(false);

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setLoading(false);
      return;
    }

    async function fetchData() {
      try {
        setLoading(true);
        const res = await fetch(`/api/talos/${talosId}/financial-projection`);
        if (res.ok) {
          setData(await res.json());
        } else {
          setError("Failed to load financial projection data");
        }
      } catch {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [talosId, initialData]);

  if (loading) {
    return (
      <div className="bg-surface border border-border p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-4 w-32 bg-border rounded" />
          <div className="h-64 bg-border/60 rounded" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border p-6">
        <p className="text-muted text-sm">{error || "No data available"}</p>
      </div>
    );
  }

  const monthlyProjectionData =
    data.projection.expectedRevenue.monthly.map((value, index) => ({
      month: `M${index + 1}`,
      revenue: value,
    }));

  const budgetSuggestionData =
    data.projection.budgetSuggestions.map((item) => ({
      category: item.category,
      amount: item.amount,
    }));

  const revenueTrend = getRevenueTrendSummary(
    data.projection.expectedRevenue.monthly
  );
  const budgetTrend = getBudgetTrendSummary(
    data.projection.budgetSuggestions
  );

  return (
    <div className="space-y-6">
      {/* Revenue Growth Chart */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 id="revenue-chart-title" className="text-sm font-bold text-accent">
            AI Revenue Projection (Next 6 Months)
          </h3>
          <button
            type="button"
            onClick={() => setShowRevenueTable((prev) => !prev)}
            aria-expanded={showRevenueTable}
            aria-controls="revenue-projection-table"
            aria-label={
              showRevenueTable
                ? "Hide revenue data table"
                : "Show revenue data table"
            }
            className="text-xs text-muted hover:text-foreground transition-colors underline focus:outline-hidden focus:ring-1 focus:ring-accent"
          >
            {showRevenueTable ? "Hide data table" : "Show data table"}
          </button>
        </div>

        <figure
          aria-labelledby="revenue-chart-title"
          role="figure"
          className="relative"
        >
          <figcaption className="sr-only">{revenueTrend}</figcaption>

          <div
            role="img"
            aria-label="AI Revenue Projection (Next 6 Months) line chart"
          >
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyProjectionData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.1)"
                />
                <XAxis
                  dataKey="month"
                  stroke="#888888"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#888888"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(0,0,0,0.8)",
                    border: "1px solid rgba(255,255,255,0.2)",
                    borderRadius: "4px",
                  }}
                  formatter={(value) => [
                    `$${Number(value ?? 0).toFixed(2)}`,
                    "",
                  ]}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  stroke="#3b82f6"
                  strokeWidth={3}
                  name="Projected Revenue"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div
            id="revenue-projection-table"
            className={showRevenueTable ? "mt-4 overflow-x-auto" : "sr-only"}
          >
            <table
              className="w-full text-left text-xs border-collapse"
              aria-label="Monthly Projected Revenue Data"
            >
              <caption className="sr-only">
                Monthly projected revenue values
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 px-3 font-semibold text-accent">
                    Month
                  </th>
                  <th
                    scope="col"
                    className="py-2 px-3 font-semibold text-accent text-right"
                  >
                    Projected Revenue
                  </th>
                </tr>
              </thead>
              <tbody>
                {monthlyProjectionData.map((row) => (
                  <tr key={row.month} className="border-b border-border/50">
                    <td className="py-1.5 px-3 text-foreground font-medium">
                      {row.month}
                    </td>
                    <td className="py-1.5 px-3 text-right text-foreground font-mono">
                      ${Number(row.revenue ?? 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      </div>

      {/* Revenue by Source Chart */}
      {budgetSuggestionData.length > 0 && (
        <div className="bg-surface border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 id="budget-chart-title" className="text-sm font-bold text-accent">
              AI Budget Suggestions
            </h3>
            <button
              type="button"
              onClick={() => setShowBudgetTable((prev) => !prev)}
              aria-expanded={showBudgetTable}
              aria-controls="budget-suggestions-table"
              aria-label={
                showBudgetTable
                  ? "Hide budget data table"
                  : "Show budget data table"
              }
              className="text-xs text-muted hover:text-foreground transition-colors underline focus:outline-hidden focus:ring-1 focus:ring-accent"
            >
              {showBudgetTable ? "Hide data table" : "Show data table"}
            </button>
          </div>

          <figure
            aria-labelledby="budget-chart-title"
            role="figure"
            className="relative"
          >
            <figcaption className="sr-only">{budgetTrend}</figcaption>

            <div
              role="img"
              aria-label="AI Budget Suggestions bar chart"
            >
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={budgetSuggestionData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <XAxis
                    dataKey="category"
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip
                    formatter={(value) => [
                      `$${Number(value ?? 0).toFixed(2)}`,
                      "Amount",
                    ]}
                  />
                  <Bar
                    dataKey="amount"
                    fill="#8b5cf6"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div
              id="budget-suggestions-table"
              className={showBudgetTable ? "mt-4 overflow-x-auto" : "sr-only"}
            >
              <table
                className="w-full text-left text-xs border-collapse"
                aria-label="AI Budget Suggestions Data"
              >
                <caption className="sr-only">
                  Budget suggestion amounts by category
                </caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="py-2 px-3 font-semibold text-accent">
                      Category
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 font-semibold text-accent text-right"
                    >
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {budgetSuggestionData.map((row) => (
                    <tr key={row.category} className="border-b border-border/50">
                      <td className="py-1.5 px-3 text-foreground font-medium">
                        {row.category}
                      </td>
                      <td className="py-1.5 px-3 text-right text-foreground font-mono">
                        ${Number(row.amount ?? 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </figure>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">
            Projected Yearly Revenue
          </p>
          <p className="text-accent text-xl font-bold">
            ${data.projection.expectedRevenue.yearly.toFixed(2)}
          </p>
        </div>

        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">
            Short-Term ROI
          </p>
          <p className="text-blue-400 text-xl font-bold">
            {data.projection.roiEstimations.shortTerm}%
          </p>
        </div>

        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">
            Long-Term ROI
          </p>
          <p className="text-amber-400 text-xl font-bold">
            {data.projection.roiEstimations.longTerm}%
          </p>
        </div>
     </div>
  </div>
  );
}
