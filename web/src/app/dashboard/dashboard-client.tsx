"use client";

import { useState, useEffect, useCallback } from "react";
import { WalletGate, useWallet } from "@/components/wallet-gate";
import { AgentAvatar } from "@/components/agent-avatar";

interface DashboardData {
  stats: {
    totalValue: string;
    activeTalos: number;
    totalRevenue: string;
    pendingCount: number;
  };
  approvals: {
    id: string;
    talosId: string;
    talosName: string;
    type: string;
    title: string;
    description: string | null;
    amount: string | null;
    timestamp: string;
  }[];
  approvalHistory: {
    id: string;
    talosId: string;
    talosName: string;
    type: string;
    title: string;
    description: string | null;
    amount: string | null;
    status: "approved" | "rejected";
    decidedBy: string | null;
    decidedAt: string | null;
    txHash: string | null;
    timestamp: string;
  }[];
  activities: {
    id: string;
    talosName: string;
    action: string;
    status: string;
    timestamp: string;
  }[];
  agents: {
    name: string;
    status: "online" | "offline";
    lastActive: string;
  }[];
  revenueStreams: {
    talosId: string;
    talosName: string;
    totalRevenue: number;
    bySource: Record<string, number>;
    recentTx: { amount: number; source: string; currency: string; date: string }[];
  }[];
  talosManagement: {
    id: string;
    name: string;
    status: string;
    approvalThreshold: number;
    gtmBudget: number;
    channels: string[];
    stellarAssetCode: string;
    totalSupply: number;
    pulsePrice: number;
    agentWalletAddress: string | null;
    apiKeyMasked: string | null;
    apiKeyRaw: string | null;
  }[];
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed" || status === "online"
      ? "text-accent font-bold"
      : status === "pending"
        ? "text-accent/60 font-semibold"
        : "text-muted";
  return (
    <span className={`text-xs ${color}`}>[{status.toUpperCase()}]</span>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="text-xs text-muted">[{type.toUpperCase()}]</span>
  );
}

export function DashboardClient() {
  return (
    <WalletGate
      title="Connect Wallet to Access Dashboard"
      description="Your patron dashboard shows your portfolio, pending approvals, and agent activity. Connect your Stellar wallet to view your TALOS holdings."
    >
      <DashboardLoader />
    </WalletGate>
  );
}

function DashboardLoader() {
  const { address } = useWallet();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard?wallet=${encodeURIComponent(address)}`);
      if (res.ok) {
        setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Initial load
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // SSE: auto-refresh when the agent creates approvals or logs activities
  useEffect(() => {
    if (!address) return;

    const es = new EventSource(
      `/api/events?wallet=${encodeURIComponent(address)}`,
    );

    es.addEventListener("update", () => fetchData());
    es.addEventListener("approval", () => fetchData());

    return () => es.close();
  }, [address, fetchData]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-pulse">
        <div className="mb-10 space-y-2">
          <div className="h-5 w-32 bg-surface border border-border rounded" />
          <div className="h-4 w-72 bg-border/60 rounded" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border p-5 space-y-2">
              <div className="h-3 w-24 bg-border/70 rounded" />
              <div className="h-7 w-20 bg-border rounded" />
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
          <div className="lg:col-span-2 space-y-4">
            <div className="h-4 w-28 bg-border rounded" />
            <div className="bg-surface border border-border divide-y divide-border">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="p-4 flex items-center justify-between">
                  <div className="space-y-2 flex-1">
                    <div className="h-4 w-48 bg-border rounded" />
                    <div className="h-3 w-32 bg-border/60 rounded" />
                  </div>
                  <div className="flex gap-2">
                    <div className="h-8 w-20 bg-border rounded" />
                    <div className="h-8 w-20 bg-border rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="h-4 w-28 bg-border rounded" />
            <div className="bg-surface border border-border divide-y divide-border">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="p-4 flex items-center gap-3">
                  <div className="w-5 h-5 bg-border rounded-full shrink-0" />
                  <div className="flex-1 space-y-1">
                    <div className="h-3 w-28 bg-border rounded" />
                    <div className="h-3 w-16 bg-border/60 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <div className="mb-10">
          <h1 className="text-accent text-lg font-bold tracking-wider mb-1">DASHBOARD</h1>
          <p className="text-muted text-sm">Failed to load dashboard data.</p>
        </div>
      </div>
    );
  }

  return <DashboardContent {...data} onRefresh={fetchData} />;
}

function ApiKeyCell({ masked, raw }: { talosId: string; masked: string | null; raw: string | null }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (raw) {
      navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (!masked) return <span className="text-muted">—</span>;

  return (
    <div className="flex items-center gap-2">
      <code className="text-foreground text-[11px] bg-background px-1.5 py-0.5 break-all">{masked}</code>
      <button
        onClick={handleCopy}
        className="text-muted hover:text-accent text-[10px] shrink-0"
        title="Copy"
      >
        {copied ? "COPIED" : "COPY"}
      </button>
    </div>
  );
}

function DashboardContent({ stats, approvals: initialApprovals, approvalHistory: initialHistory, activities, agents, revenueStreams, talosManagement, onRefresh }: DashboardData & { onRefresh: () => void }) {
  const [approvals, setApprovals] = useState(initialApprovals);
  const [approvalHistory, setApprovalHistory] = useState(initialHistory);
  const [approvalTab, setApprovalTab] = useState<"pending" | "history">("pending");
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const { address } = useWallet();

  async function handleDecision(id: string, talosId: string, status: "approved" | "rejected") {
    setApprovalError(null);
    const target = approvals.find((a) => a.id === id);
    try {
      const res = await fetch(`/api/talos/${talosId}/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, decidedBy: address }),
      });
      if (res.ok) {
        const result = await res.json();
        setApprovals((prev) => prev.filter((a) => a.id !== id));
        if (target) {
          setApprovalHistory((prev) => [
            {
              ...target,
              status,
              decidedBy: address ?? null,
              decidedAt: new Date().toISOString(),
              txHash: result.txHash ?? null,
            },
            ...prev,
          ]);
        }
      } else {
        const data = await res.json().catch(() => null);
        setApprovalError(data?.error ?? `Failed to ${status === "approved" ? "approve" : "reject"} (${res.status})`);
      }
    } catch {
      setApprovalError("Network error — please try again.");
    }
  }

  const hasNoData = agents.length === 0 && talosManagement.length === 0;

  const PORTFOLIO_STATS = [
    { label: "Total Value", value: stats.totalValue },
    { label: "Active TALOS", value: stats.activeTalos.toString() },
    { label: "Total Revenue", value: stats.totalRevenue },
    { label: "Pending Approvals", value: stats.pendingCount.toString() },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <div className="mb-10">
        <h1 className="text-accent text-lg font-bold tracking-wider mb-1">DASHBOARD</h1>
        <p className="text-muted text-sm">patron control panel &mdash; portfolio overview, approvals, activity</p>
      </div>

      {hasNoData ? (
        <div className="bg-surface border border-border p-10 text-center">
          <p className="text-muted text-sm mb-2">No agents found for your wallet.</p>
          <p className="text-muted text-xs">Create or join a TALOS to see your dashboard.</p>
        </div>
      ) : (
        <>
          {/* Portfolio Overview */}
          <section className="mb-10">
            <h2 className="text-sm text-muted mb-4 tracking-wide">// PORTFOLIO OVERVIEW</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {PORTFOLIO_STATS.map((stat) => (
                <div key={stat.label} className="bg-surface border border-border p-5 hover:bg-surface-hover transition-colors">
                  <p className="text-muted text-sm mb-2 uppercase tracking-wider">{stat.label}</p>
                  <p className="text-accent text-2xl font-bold">{stat.value}</p>
                </div>
              ))}
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
            {/* Approval Queue */}
            <section className="lg:col-span-2">
              <div className="flex items-center gap-4 mb-4">
                <button
                  onClick={() => setApprovalTab("pending")}
                  className={`text-sm tracking-wide transition-colors ${approvalTab === "pending" ? "text-accent" : "text-muted hover:text-foreground"}`}
                >
                  // PENDING ({approvals.length})
                </button>
                <button
                  onClick={() => setApprovalTab("history")}
                  className={`text-sm tracking-wide transition-colors ${approvalTab === "history" ? "text-accent" : "text-muted hover:text-foreground"}`}
                >
                  // HISTORY ({approvalHistory.length})
                </button>
              </div>

              {approvalError && (
                <div className="mb-3 bg-accent/10 border border-accent/20 text-accent text-xs px-4 py-2.5 flex items-center justify-between">
                  <span>{approvalError}</span>
                  <button onClick={() => setApprovalError(null)} className="text-accent hover:text-accent/70 ml-4 font-bold">DISMISS</button>
                </div>
              )}

              {approvalTab === "pending" && (
                <div className="bg-surface border border-border divide-y divide-border">
                  {approvals.length === 0 && (
                    <div className="p-6 text-muted text-sm text-center">No pending approvals.</div>
                  )}
                  {approvals.map((item) => (
                    <div key={item.id} className="p-4 hover:bg-surface-hover transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <TypeBadge type={item.type} />
                            <span className="text-xs text-muted">{item.talosName}</span>
                            {item.amount && <span className="text-xs text-accent">{item.amount}</span>}
                          </div>
                          <p className="text-sm text-foreground truncate">{item.title}</p>
                          {item.description && (
                            <p className="text-xs text-muted mt-0.5">{item.description}</p>
                          )}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={() => handleDecision(item.id, item.talosId, "approved")}
                            className="border border-accent text-accent px-3 py-1.5 text-xs hover:bg-accent hover:text-white transition-colors font-bold"
                          >
                            APPROVE
                          </button>
                          <button
                            onClick={() => handleDecision(item.id, item.talosId, "rejected")}
                            className="border border-muted text-muted px-3 py-1.5 text-xs hover:bg-muted hover:text-white transition-colors"
                          >
                            REJECT
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {approvalTab === "history" && (
                <div className="bg-surface border border-border divide-y divide-border">
                  {approvalHistory.length === 0 && (
                    <div className="p-6 text-muted text-sm text-center">No approval history.</div>
                  )}
                  {approvalHistory.map((item) => (
                    <div key={item.id} className="p-4 hover:bg-surface-hover transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <TypeBadge type={item.type} />
                            <span className="text-xs text-muted">{item.talosName}</span>
                            {item.amount && <span className="text-xs text-accent">{item.amount}</span>}
                            <span className={`text-xs font-bold ${item.status === "approved" ? "text-accent" : "text-muted"}`}>
                              [{item.status.toUpperCase()}]
                            </span>
                          </div>
                          <p className="text-sm text-foreground truncate">{item.title}</p>
                          {item.description && (
                            <p className="text-xs text-muted mt-0.5">{item.description}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1.5 text-xs text-muted">
                            {item.decidedAt && (
                              <span>{new Date(item.decidedAt).toLocaleString()}</span>
                            )}
                            {item.decidedBy && (
                              <>
                                <span>&middot;</span>
                                <span className="font-mono">{item.decidedBy.slice(0, 6)}...{item.decidedBy.slice(-4)}</span>
                              </>
                            )}
                            {item.txHash && (
                              <>
                                <span>&middot;</span>
                                <a
                                  href={`https://stellar.expert/explorer/testnet/tx/${item.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-accent hover:underline font-mono"
                                >
                                  TX {item.txHash.slice(0, 8)}...{item.txHash.slice(-6)}
                                </a>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Agent Status */}
            <section>
              <h2 className="text-sm text-muted mb-4 tracking-wide">// AGENT STATUS</h2>
              <div className="bg-surface border border-border divide-y divide-border">
                {agents.length === 0 && (
                  <div className="p-6 text-muted text-sm text-center">No agents.</div>
                )}
                {agents.map((agent, i) => (
                  <div key={`${agent.name}-${i}`} className="p-4 flex items-center justify-between hover:bg-surface-hover transition-colors">
                    <div className="flex items-center gap-2">
                      <AgentAvatar name={agent.name} size={20} className="shrink-0" />
                      <div>
                        <p className="text-sm text-foreground">{agent.name}</p>
                        <p className="text-xs text-muted mt-0.5">last: {agent.lastActive}</p>
                      </div>
                    </div>
                    <StatusBadge status={agent.status} />
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Revenue Stream */}
          <section className="mb-10">
            <h2 className="text-sm text-muted mb-4 tracking-wide">// REVENUE STREAM</h2>
            {revenueStreams.length === 0 ? (
              <div className="bg-surface border border-border p-6 text-muted text-sm text-center">No revenue data yet.</div>
            ) : (
              <div className="space-y-4">
                {revenueStreams.map((rs) => (
                  <div key={rs.talosId} className="bg-surface border border-border p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold text-accent inline-flex items-center gap-2">
                        <AgentAvatar name={rs.talosName} size={18} className="shrink-0" />
                        {rs.talosName}
                      </h3>
                      <span className="text-sm text-foreground font-bold">${rs.totalRevenue.toFixed(2)}</span>
                    </div>
                    <div className="mb-4 px-3 py-2 bg-background border border-border text-xs text-muted">
                      100% Agent Treasury &mdash; revenue funds operations &amp; Mitos buyback
                    </div>
                    <div className="flex gap-3 mb-4">
                      {Object.entries(rs.bySource).map(([source, amount]) => (
                        <span key={source} className="text-xs text-muted">
                          {source}: <span className="text-foreground">${amount.toFixed(2)}</span>
                        </span>
                      ))}
                    </div>
                    {rs.recentTx.length > 0 && (
                      <div className="border-t border-border pt-3 space-y-2">
                        {rs.recentTx.map((tx, i) => (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                              <span className="text-muted">{new Date(tx.date).toLocaleDateString()}</span>
                              <span className="text-muted">[{tx.source.toUpperCase()}]</span>
                            </div>
                            <span className="text-foreground">+${tx.amount.toFixed(2)} {tx.currency}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* On-chain Status */}
          <section className="mb-10">
            <h2 className="text-sm text-muted mb-4 tracking-wide">// ON-CHAIN STATUS</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {talosManagement.map((c) => (
                <div key={c.id} className="bg-surface border border-border p-5">
                  <h3 className="text-sm font-bold text-accent mb-3 flex items-center gap-2">
                    <AgentAvatar name={c.name} size={18} className="shrink-0" />
                    {c.name}
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="text-muted shrink-0">Asset Code</span>
                      <span className="text-foreground font-mono truncate text-right">
                        {c.stellarAssetCode?.includes(":")
                          ? `${c.stellarAssetCode.split(":")[0]}:${c.stellarAssetCode.split(":")[1].slice(0, 6)}…`
                          : c.stellarAssetCode || "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Network</span>
                      <span className="text-foreground">Stellar</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Supply</span>
                      <span className="text-foreground">{c.totalSupply.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Mitos Price</span>
                      <span className="text-accent">${c.pulsePrice.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Revenue Model</span>
                      <span className="text-foreground">Agent Treasury</span>
                    </div>
                    {c.agentWalletAddress && (
                      <a
                        href={`https://stellar.expert/explorer/testnet/account/${c.agentWalletAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-center border border-border py-1.5 text-muted hover:text-accent hover:border-accent transition-colors mt-2"
                      >
                        View on Stellar Expert &rarr;
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* TALOS Management */}
          <section className="mb-10">
            <h2 className="text-sm text-muted mb-4 tracking-wide">// TALOS MANAGEMENT</h2>
            <div className="bg-surface border border-border divide-y divide-border">
              {talosManagement.map((c) => (
                <div key={c.id} className="p-5 hover:bg-surface-hover transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                        <AgentAvatar name={c.name} size={18} className="shrink-0" />
                        {c.name}
                      </h3>
                      <span className={`text-xs font-bold ${c.status === "Active" ? "text-accent" : "text-muted opacity-50"}`}>
                        [{c.status.toUpperCase()}]
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                    <div>
                      <span className="text-muted">Approval Threshold</span>
                      <p className="text-foreground mt-0.5">&gt; ${c.approvalThreshold} USDC</p>
                    </div>
                    <div>
                      <span className="text-muted">GTM Budget</span>
                      <p className="text-foreground mt-0.5">${c.gtmBudget}/mo</p>
                    </div>
                    <div>
                      <span className="text-muted">Channels</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {c.channels.map((ch) => (
                          <span key={ch} className="border border-border px-1.5 py-0.5 text-foreground">{ch}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted">Asset</span>
                      <p className="text-foreground mt-0.5 font-mono break-all text-xs">
                        {c.stellarAssetCode || "—"}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border text-xs">
                    <span className="text-muted">Agent API Key</span>
                    <div className="mt-1">
                      <ApiKeyCell talosId={c.id} masked={c.apiKeyMasked} raw={c.apiKeyRaw} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Activity Feed */}
          <section className="mb-10">
            <h2 className="text-sm text-muted mb-4 tracking-wide">// ACTIVITY FEED</h2>
            <div className="bg-surface border border-border">
              {activities.length === 0 && (
                <div className="p-6 text-muted text-sm text-center">No activity yet.</div>
              )}
              {activities.map((item, i) => (
                <div
                  key={item.id}
                  className={`p-4 flex items-start gap-4 hover:bg-surface-hover transition-colors ${
                    i < activities.length - 1 ? "border-b border-border" : ""
                  }`}
                >
                  <div className="flex flex-col items-center pt-1.5 shrink-0">
                    <div className={`w-1.5 h-1.5 rounded-full ${item.status === "completed" ? "bg-accent" : "bg-muted"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs text-muted font-mono">
                        {new Date(item.timestamp).toLocaleString()}
                      </span>
                      <span className="text-xs text-muted">&middot;</span>
                      <span className="text-xs text-accent inline-flex items-center gap-1">
                        <AgentAvatar name={item.talosName} size={14} className="shrink-0" />
                        {item.talosName}
                      </span>
                      <StatusBadge status={item.status} />
                    </div>
                    <p className="text-sm text-foreground">{item.action}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
