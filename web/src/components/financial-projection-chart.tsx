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

interface FinancialProjectionData {
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

interface FinancialProjectionChartProps {
  talosId: string;
}

export function FinancialProjectionChart({ talosId }: FinancialProjectionChartProps) {
  const [data, setData] = useState<FinancialProjectionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const res = await fetch(`/api/talos/${talosId}/financial-projection`);
        if (res.ok) {
          setData(await res.json());
        } else {
          setError("Failed to load financial projection data");
        }
      } catch (err) {
        setError("Network error");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [talosId]);

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

  return (
    <div className="space-y-6">
      {/* Revenue Growth Chart */}
      <div className="bg-surface border border-border p-6">
        <h3 className="text-sm font-bold text-accent mb-4">
          AI Revenue Projection (Next 6 Months)
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={monthlyProjectionData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
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
                backgroundColor: 'rgba(0,0,0,0.8)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px'
              }}
              formatter={(value) => [
                `$${Number(value ?? 0).toFixed(2)}`,
                ""
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
    

      {/* Revenue by Source Chart */}
      {budgetSuggestionData.length > 0 && (
        <div className="bg-surface border border-border p-6">
          <h3 className="text-sm font-bold text-accent mb-4">
            AI Budget Suggestions
          </h3>

          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={budgetSuggestionData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />

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
                formatter={(value) => [`$${Number(value ?? 0).toFixed(2)}`, "Amount"]}
              />

              <Bar
                dataKey="amount"
                fill="#8b5cf6"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
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
