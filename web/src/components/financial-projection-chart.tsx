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

interface MonthlyData {
  month: string;
  actualRevenue: number;
  projectedRevenue: number;
  budgetTarget: number;
}

interface FinancialProjectionData {
  talos: {
    id: string;
    name: string;
    budgetTarget: number;
  };
  monthlyData: MonthlyData[];
  revenueBySource: Record<string, number>;
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

  const revenueBySourceData = Object.entries(data.revenueBySource).map(([source, amount]) => ({
    source: source.charAt(0).toUpperCase() + source.slice(1),
    amount: Math.round(amount * 100) / 100,
  }));

  return (
    <div className="space-y-6">
      {/* Revenue Growth Chart */}
      <div className="bg-surface border border-border p-6">
        <h3 className="text-sm font-bold text-accent mb-4">
          {data.talos.name} — Revenue Growth Projection
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.monthlyData}>
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
              formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
            />
            <Legend />
            <Line 
              type="monotone" 
              dataKey="actualRevenue" 
              stroke="#10b981" 
              strokeWidth={2}
              name="Actual Revenue"
              dot={{ fill: '#10b981' }}
            />
            <Line 
              type="monotone" 
              dataKey="projectedRevenue" 
              stroke="#3b82f6" 
              strokeWidth={2}
              strokeDasharray="5 5"
              name="AI Projected"
              dot={{ fill: '#3b82f6' }}
            />
            <Line 
              type="monotone" 
              dataKey="budgetTarget" 
              stroke="#f59e0b" 
              strokeWidth={2}
              strokeDasharray="3 3"
              name="Budget Target"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Revenue by Source Chart */}
      {revenueBySourceData.length > 0 && (
        <div className="bg-surface border border-border p-6">
          <h3 className="text-sm font-bold text-accent mb-4">
            Revenue by Source
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={revenueBySourceData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis 
                dataKey="source" 
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
                formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
              />
              <Bar dataKey="amount" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Summary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">Total Actual Revenue</p>
          <p className="text-accent text-xl font-bold">
            ${data.monthlyData.reduce((sum, d) => sum + d.actualRevenue, 0).toFixed(2)}
          </p>
        </div>
        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">Total Projected Revenue</p>
          <p className="text-blue-400 text-xl font-bold">
            ${data.monthlyData.reduce((sum, d) => sum + d.projectedRevenue, 0).toFixed(2)}
          </p>
        </div>
        <div className="bg-surface border border-border p-4">
          <p className="text-muted text-xs uppercase tracking-wider mb-1">Monthly Budget Target</p>
          <p className="text-amber-400 text-xl font-bold">
            ${data.talos.budgetTarget.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}
