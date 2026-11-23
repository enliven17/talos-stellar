"use client";

import type { TalosDetail, DistPreview, BuybackPreview } from "./types";
import { AgentEmptyState } from "@/components/agent-view-states";
import { FinancialSnapshotBadge, FinancialMetricValue } from "@/components/financial-state";

interface TabRevenueProps {
  talos: TalosDetail;
  address: string | undefined;
  isConnected: boolean;
  distPreview: DistPreview | null;
  distLoading: boolean;
  onLoadDistPreview: () => void;
  onDistribute: () => void;
  buybackPreview: BuybackPreview | null;
  buybackLoading: boolean;
  buybackForm: { usdcAmount: string; mitosAmount: string };
  onBuybackFormChange: (field: "usdcAmount" | "mitosAmount", value: string) => void;
  onLoadBuybackPreview: () => void;
  onBuyback: () => void;
  distError?: string | null;
  buybackError?: string | null;
}

export function TabRevenue({
  talos,
  address,
  isConnected,
  distPreview,
  distLoading,
  onLoadDistPreview,
  onDistribute,
  buybackPreview,
  buybackLoading,
  buybackForm,
  onBuybackFormChange,
  onLoadBuybackPreview,
  onBuyback,
  distError,
  buybackError,
}: TabRevenueProps) {
  const REVENUE_HISTORY = talos.revenueHistory ?? [];
  const maxRevenue = Math.max(...REVENUE_HISTORY.map((r) => r.amount), 1);

  return (
    <div className="space-y-6">
      {/* Summary metrics */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted">[FINANCIAL OVERVIEW]</span>
          <FinancialSnapshotBadge observedAt={talos.observedAt} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Total Revenue", value: talos.revenue },
            {
              label: "This Month",
              value: `$${(REVENUE_HISTORY[REVENUE_HISTORY.length - 1]?.amount ?? 0).toLocaleString()}`,
            },
            {
              label: "Avg Monthly",
              value: `$${Math.round(
                REVENUE_HISTORY.length > 0
                  ? REVENUE_HISTORY.reduce((s, r) => s + r.amount, 0) /
                      REVENUE_HISTORY.length
                  : 0,
              ).toLocaleString()}`,
            },
            {
              label: "From Jobs",
              value: `$${talos.jobStats.totalRevenue.toLocaleString()}`,
            },
          ].map((s) => (
            <div
              key={s.label}
              className="bg-surface border border-border p-4 text-center"
            >
              <div className="text-xl font-bold text-accent">{s.value}</div>
              <div className="text-xs text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Distribution Panel */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-accent">[REVENUE DISTRIBUTION]</span>
            {distPreview && (
              <FinancialSnapshotBadge
                observedAt={distPreview.observedAt}
                onRefresh={onLoadDistPreview}
                refreshing={distLoading}
              />
            )}
          </div>
          <button
            onClick={onLoadDistPreview}
            disabled={distLoading}
            className="text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
          >
            {distLoading ? "Loading…" : "Load preview →"}
          </button>
        </div>
        <p className="text-xs text-muted mb-4">
          {talos.investorShare ?? 25}% of treasury revenue is distributable to{" "}
          {talos.tokenSymbol} holders proportionally to their holdings.
        </p>
        {distError ? (
          <div className="p-4 border border-red-500/30 bg-red-500/10 text-xs text-red-400 flex items-center justify-between">
            <span>{distError}</span>
            <button
              onClick={onLoadDistPreview}
              className="text-xs underline hover:text-red-300 ml-4 font-mono"
            >
              Retry
            </button>
          </div>
        ) : distLoading && !distPreview ? (
          <div className="py-8 text-center text-xs text-muted animate-pulse">
            Loading revenue distribution preview…
          </div>
        ) : distPreview ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
              <div className="bg-background border border-border p-3 text-center">
                <div className="text-accent font-bold text-sm">
                  <FinancialMetricValue
                    value={distPreview.totalRevenue.toFixed(2)}
                    prefix="$"
                    state={distPreview.totalRevenue != null ? "live" : "unavailable"}
                  />
                </div>
                <div className="text-muted">Total Treasury</div>
              </div>
              <div className="bg-background border border-border p-3 text-center">
                <div className="text-accent font-bold text-sm">
                  <FinancialMetricValue
                    value={distPreview.distributableAmount.toFixed(2)}
                    prefix="$"
                    state={distPreview.distributableAmount != null ? "live" : "unavailable"}
                  />
                </div>
                <div className="text-muted">
                  To Distribute ({distPreview.investorSharePercent}%)
                </div>
              </div>
              <div className="bg-background border border-border p-3 text-center">
                <div className="text-foreground font-bold text-sm">
                  <FinancialMetricValue
                    value={(
                      distPreview.totalRevenue - distPreview.distributableAmount
                    ).toFixed(2)}
                    prefix="$"
                    state={distPreview.totalRevenue != null ? "live" : "unavailable"}
                  />
                </div>
                <div className="text-muted">Treasury Retained</div>
              </div>
            </div>
            <div className="space-y-1">
              {distPreview.breakdown.map((b) => (
                <div
                  key={b.stellarPublicKey}
                  className={`flex items-center justify-between text-xs py-1.5 border-b border-border last:border-0 ${
                    b.stellarPublicKey === address
                      ? "text-accent"
                      : "text-muted"
                  }`}
                >
                  <span className="font-mono">
                    {b.stellarPublicKey === address
                      ? "You"
                      : `${b.stellarPublicKey.slice(0, 8)}...`}
                  </span>
                  <span>
                    {b.pulseAmount.toLocaleString()} {talos.tokenSymbol} (
                    {b.sharePercent}%)
                  </span>
                  <span className="font-bold">${b.estimatedUsdc} USDC</span>
                </div>
              ))}
            </div>
            {isConnected && (
              <button
                onClick={onDistribute}
                disabled={
                  distLoading || distPreview.distributableAmount <= 0
                }
                className={`w-full py-2.5 text-sm font-medium transition-colors ${
                  distPreview.distributableAmount > 0
                    ? "bg-accent text-background hover:bg-foreground"
                    : "bg-surface text-muted border border-border cursor-not-allowed"
                }`}
              >
                {distLoading
                  ? "Distributing..."
                  : `Distribute ${distPreview.distributableAmount.toFixed(2)} USDC to Holders`}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={onLoadDistPreview}
            className="border border-border px-4 py-2 text-xs text-muted hover:text-accent hover:border-accent transition-colors"
          >
            Load distribution preview
          </button>
        )}
      </div>

      {/* Revenue History chart */}
      <div className="bg-surface border border-border p-6">
        <div className="text-xs text-muted mb-6">[REVENUE HISTORY]</div>
        {REVENUE_HISTORY.length === 0 ? (
          <AgentEmptyState kind="revenue" className="py-12" />
        ) : (
          <div className="flex items-end gap-3 h-40">
            {REVENUE_HISTORY.map((r) => (
              <div
                key={r.month}
                className="flex-1 flex flex-col items-center gap-2"
              >
                <span className="text-xs text-accent">
                  ${(r.amount / 1000).toFixed(1)}K
                </span>
                <div
                  className="w-full bg-border relative"
                  style={{ height: `${(r.amount / maxRevenue) * 100}%` }}
                >
                  <div className="absolute inset-0 bg-foreground/20 hover:bg-foreground/40 transition-colors" />
                </div>
                <span className="text-xs text-muted">{r.month}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Buyback section */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-accent">[TREASURY BUYBACK]</span>
            {buybackPreview && (
              <FinancialSnapshotBadge
                observedAt={buybackPreview.observedAt}
                onRefresh={onLoadBuybackPreview}
                refreshing={buybackLoading}
              />
            )}
          </div>
          <button
            onClick={onLoadBuybackPreview}
            disabled={buybackLoading}
            className="text-xs text-muted hover:text-accent transition-colors disabled:opacity-50"
          >
            {buybackLoading ? "Loading…" : "Load stats →"}
          </button>
        </div>
        <p className="text-xs text-muted mb-4">
          Burns {talos.tokenSymbol} tokens from treasury, reducing circulating
          supply.
        </p>
        {buybackError ? (
          <div className="p-4 border border-red-500/30 bg-red-500/10 text-xs text-red-400 flex items-center justify-between">
            <span>{buybackError}</span>
            <button
              onClick={onLoadBuybackPreview}
              className="text-xs underline hover:text-red-300 ml-4 font-mono"
            >
              Retry
            </button>
          </div>
        ) : buybackLoading && !buybackPreview ? (
          <div className="py-8 text-center text-xs text-muted animate-pulse">
            Loading treasury buyback statistics…
          </div>
        ) : buybackPreview ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              {[
                {
                  label: "Treasury Balance",
                  value: buybackPreview.treasuryBalance != null ? `$${buybackPreview.treasuryBalance.toFixed(2)}` : null,
                },
                {
                  label: "Total Burned",
                  value: buybackPreview.totalBuybackExecuted != null ? `$${buybackPreview.totalBuybackExecuted.toFixed(2)}` : null,
                },
                {
                  label: "Circulating Supply",
                  value: buybackPreview.circulatingSupply != null ? buybackPreview.circulatingSupply.toLocaleString() : null,
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="bg-background border border-border p-3 text-center"
                >
                  <div className="font-bold text-accent">
                    <FinancialMetricValue
                      value={s.value}
                      state={s.value != null ? "live" : "unavailable"}
                    />
                  </div>
                  <div className="text-muted mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
            {isConnected && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted block mb-1">
                    USDC to spend
                  </label>
                  <input
                    type="number"
                    value={buybackForm.usdcAmount}
                    onChange={(e) =>
                      onBuybackFormChange("usdcAmount", e.target.value)
                    }
                    className="w-full bg-surface border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted block mb-1">
                    {talos.tokenSymbol} to burn
                  </label>
                  <input
                    type="number"
                    value={buybackForm.mitosAmount}
                    onChange={(e) =>
                      onBuybackFormChange("mitosAmount", e.target.value)
                    }
                    className="w-full bg-surface border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent"
                    placeholder="0"
                  />
                </div>
              </div>
            )}
            {isConnected && (
              <button
                onClick={onBuyback}
                disabled={
                  buybackLoading ||
                  !buybackForm.usdcAmount ||
                  !buybackForm.mitosAmount
                }
                className="w-full py-2.5 text-sm font-medium bg-accent text-background hover:bg-foreground transition-colors disabled:opacity-50"
              >
                {buybackLoading
                  ? "Processing..."
                  : `Burn ${buybackForm.mitosAmount || "0"} ${talos.tokenSymbol}`}
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={onLoadBuybackPreview}
            className="border border-border px-4 py-2 text-xs text-muted hover:text-accent hover:border-accent transition-colors"
          >
            Load buyback stats
          </button>
        )}
      </div>
    </div>
  );
}
