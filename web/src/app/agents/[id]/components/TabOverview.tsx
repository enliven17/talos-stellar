"use client";

import type { TalosDetail, Tab, TYPE_ICONS } from "./types";
import { JOB_STATUS_STYLES } from "./types";

interface TabOverviewProps {
  talos: TalosDetail;
  typeIcons: typeof TYPE_ICONS;
  minRequired: number;
  onTabSwitch: (tab: Tab) => void;
}

export function TabOverview({
  talos,
  typeIcons,
  minRequired,
  onTabSwitch,
}: TabOverviewProps) {
  return (
    <div className="grid lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        {/* Service highlight */}
        {talos.service && (
          <div className="bg-surface border border-accent/20 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xs text-accent">[SERVICE OFFERED]</div>
              <button
                onClick={() => onTabSwitch("Services")}
                className="text-xs text-muted hover:text-accent transition-colors"
              >
                Details &rarr;
              </button>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-foreground">
                  {talos.service.name}
                </h3>
                {talos.service.description && (
                  <p className="text-xs text-muted mt-1 max-w-md">
                    {talos.service.description}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold text-accent">
                  {talos.service.price} {talos.service.currency}
                </div>
                <div className="text-xs text-muted">per request</div>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-border flex items-center gap-4 text-xs text-muted">
              <span>{talos.jobStats.completed} jobs completed</span>
              {talos.jobStats.successRate !== null && (
                <span
                  className={
                    talos.jobStats.successRate >= 90
                      ? "text-accent font-bold"
                      : talos.jobStats.successRate >= 70
                        ? "text-muted"
                        : "text-red-600"
                  }
                >
                  {talos.jobStats.successRate}% success rate
                </span>
              )}
              <span>Chains: {talos.service.chains.join(", ")}</span>
            </div>
          </div>
        )}

        {/* Kernel Policy */}
        <div className="bg-surface border border-border p-6">
          <div className="text-xs text-muted mb-4">[KERNEL POLICY]</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted">Approval Threshold</span>
              <p className="text-foreground mt-1">
                &gt; ${talos.approvalThreshold} USDC
              </p>
            </div>
            <div>
              <span className="text-muted">GTM Budget</span>
              <p className="text-foreground mt-1">${talos.gtmBudget}/month</p>
            </div>
            <div>
              <span className="text-muted">
                Min Patron {talos.tokenSymbol}
              </span>
              <p className="text-foreground mt-1">
                {minRequired.toLocaleString()} {talos.tokenSymbol}
              </p>
            </div>
            <div>
              <span className="text-muted">Channels</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {talos.channels.map((ch) => (
                  <span
                    key={ch}
                    className="text-xs border border-border px-2 py-0.5 text-foreground"
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Prime Agent */}
        <div className="bg-surface border border-border p-6">
          <div className="text-xs text-muted mb-4">[PRIME AGENT]</div>
          <div className="space-y-4 text-sm">
            <div>
              <span className="text-muted">Persona</span>
              <p className="text-foreground mt-1">{talos.persona}</p>
            </div>
            <div>
              <span className="text-muted">Target Audience</span>
              <p className="text-foreground mt-1">{talos.targetAudience}</p>
            </div>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-surface border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs text-muted">[RECENT ACTIVITY]</div>
            <button
              onClick={() => onTabSwitch("Activity")}
              className="text-xs text-muted hover:text-accent transition-colors"
            >
              View all &rarr;
            </button>
          </div>
          <div className="space-y-3">
            {talos.activities.slice(0, 4).map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-3 py-2 border-b border-border last:border-0"
              >
                <span className="text-xs text-muted w-5 shrink-0 font-bold">
                  {typeIcons[a.type]}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate">{a.content}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                    <span>{a.channel}</span>
                    <span>{a.timestamp}</span>
                  </div>
                </div>
                <span
                  className={`text-xs shrink-0 ${
                    a.status === "completed"
                      ? "text-accent font-bold"
                      : a.status === "pending"
                        ? "text-muted"
                        : "text-red-600"
                  }`}
                >
                  [{a.status.toUpperCase()}]
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="space-y-6">
        {/* Job Performance */}
        {talos.jobStats.total > 0 && (
          <div className="bg-surface border border-border p-6">
            <div className="text-xs text-muted mb-4">[JOB PERFORMANCE]</div>
            <div className="space-y-3">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Total Jobs</span>
                <span className="text-foreground font-bold">
                  {talos.jobStats.total}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Completed</span>
                <span className="text-green-400">
                  {talos.jobStats.completed}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Failed</span>
                <span className="text-red-400">{talos.jobStats.failed}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Pending</span>
                <span className="text-yellow-400">
                  {talos.jobStats.pending}
                </span>
              </div>
              {talos.jobStats.successRate !== null && (
                <div className="pt-2 border-t border-border">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-muted">Success Rate</span>
                    <span
                      className={
                        talos.jobStats.successRate >= 90
                          ? "text-green-400"
                          : talos.jobStats.successRate >= 70
                            ? "text-yellow-400"
                            : "text-red-400"
                      }
                    >
                      {talos.jobStats.successRate}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-border">
                    <div
                      className={`h-full ${
                        talos.jobStats.successRate >= 90
                          ? "bg-green-400"
                          : talos.jobStats.successRate >= 70
                            ? "bg-yellow-400"
                            : "bg-red-400"
                      }`}
                      style={{ width: `${talos.jobStats.successRate}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="flex justify-between text-xs pt-2 border-t border-border">
                <span className="text-muted">Job Revenue</span>
                <span className="text-accent font-bold">
                  ${talos.jobStats.totalRevenue.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Revenue Model */}
        <div className="bg-surface border border-border p-6">
          <div className="text-xs text-muted mb-4">[REVENUE MODEL]</div>
          <div className="space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Model</span>
              <span className="text-foreground">Agent Treasury</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Revenue Destination</span>
              <span className="text-accent">100% Agent Wallet</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Creator Earnings</span>
              <span className="text-foreground">Service Fees</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">
                {talos.tokenSymbol} Mechanism
              </span>
              <span className="text-foreground">Governance + Access</span>
            </div>
            <div className="pt-2 border-t border-border text-muted leading-relaxed">
              All revenue stays in the agent treasury for operations and{" "}
              {talos.tokenSymbol} buyback &amp; burn. No direct distribution to
              token holders.
            </div>
          </div>
        </div>

        {/* On-chain */}
        <div className="bg-surface border border-border p-6">
          <div className="text-xs text-muted mb-4">[ON-CHAIN]</div>
          <div className="space-y-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Network</span>
              <span className="text-foreground">Stellar Network</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted shrink-0">Asset Code</span>
              <span className="text-foreground font-mono truncate text-right">
                {talos.stellarAssetCode?.includes(":")
                  ? `${talos.stellarAssetCode.split(":")[0]}:${talos.stellarAssetCode.split(":")[1].slice(0, 6)}…`
                  : talos.stellarAssetCode || talos.tokenSymbol}
              </span>
            </div>
            {talos.agentWalletAddress && (
              <div className="flex justify-between">
                <span className="text-muted">Agent Wallet</span>
                <span className="text-foreground font-mono truncate max-w-[60%]">
                  {talos.agentWalletAddress.slice(0, 8)}...
                  {talos.agentWalletAddress.slice(-4)}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted">Total Supply</span>
              <span className="text-foreground">
                {talos.totalSupply.toLocaleString()}
              </span>
            </div>
            {talos.agentWalletAddress && (
              <a
                href={`https://stellar.expert/explorer/testnet/account/${talos.agentWalletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-center border border-border py-1.5 text-muted hover:text-accent hover:border-accent transition-colors mt-2"
              >
                View on Stellar Expert &rarr;
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
