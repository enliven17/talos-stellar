"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { AgentAvatar } from "@/components/agent-avatar";

// ─── Types ───────────────────────────────────────────────────────

interface Transaction {
  id: string;
  type: "service" | "playbook";
  sellerName: string;
  sellerAgent: string | null;
  buyerName: string;
  buyerAgent: string | null;
  itemName: string;
  amount: number;
  currency: string;
  status: string;
  timestamp: string;
  txHash: string | null;
}

interface Props {
  stats: {
    totalTransactions: number;
    totalVolume: number;
    activeAgents: number;
    totalAgents: number;
    registeredServices: number;
    playbooksTraded: number;
  };
  transactions: Transaction[];
  initialCursor: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

const FILTERS = ["All", "Service", "Playbook"] as const;
type Filter = (typeof FILTERS)[number];

function getRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AgentLabel({ name, agent }: { name: string; agent: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <AgentAvatar name={agent || name} size={18} className="shrink-0" />
      <span className="text-foreground font-medium truncate">{name}</span>
      {agent && (
        <span className="text-muted/50 font-mono text-[10px] shrink-0">
          @{agent}
        </span>
      )}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-accent"
      : status === "pending"
        ? "bg-muted animate-pulse"
        : status === "in_progress"
          ? "bg-accent/60 animate-pulse"
          : "bg-muted/40";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

// ─── Component ───────────────────────────────────────────────────

const PAGE_SIZE = 25;
const POLL_INTERVAL = 5_000;

export function ActivityClient({ stats: initialStats, transactions: initialTransactions, initialCursor }: Props) {
  const [filter, setFilter] = useState<Filter>("All");
  const [stats, setStats] = useState(initialStats);
  const [transactions, setTransactions] = useState(initialTransactions);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [prevCursors, setPrevCursors] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // Poll stats + transactions (first page only)
  const refresh = useCallback(async () => {
    try {
      const isFirstPage = page === 1;
      const params = new URLSearchParams(
        isFirstPage ? { limit: String(PAGE_SIZE) } : { statsOnly: "true" }
      );
      const res = await fetch(`/api/activity?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data.stats);
      if (isFirstPage) {
        setTransactions(data.transactions);
        setNextCursor(data.nextCursor);
      }
    } catch { /* silent */ }
  }, [page]);

  useEffect(() => {
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  const fetchPage = useCallback(async (cursor: string | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`/api/activity?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setTransactions(data.transactions);
      setNextCursor(data.nextCursor);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  const goNext = useCallback(() => {
    if (!nextCursor || loading) return;
    const currentFirst = transactions[0]?.timestamp ?? null;
    setPrevCursors((prev) => [...prev, currentFirst ?? ""]);
    setPage((p) => p + 1);
    fetchPage(nextCursor);
  }, [nextCursor, loading, transactions, fetchPage]);

  const goPrev = useCallback(() => {
    if (prevCursors.length === 0 || loading) return;
    const prev = [...prevCursors];
    const cursor = prev.pop()!;
    setPrevCursors(prev);
    setPage((p) => p - 1);
    fetchPage(cursor || null);
  }, [prevCursors, loading, fetchPage]);

  const filtered = useMemo(() => {
    if (filter === "All") return transactions;
    return transactions.filter(
      (t) => t.type === filter.toLowerCase()
    );
  }, [transactions, filter]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="mb-10">
        <div className="text-sm text-muted mb-2 tracking-wide">// AGENT ECONOMY</div>
        <h1 className="text-2xl font-bold text-accent tracking-tight">
          Activity
        </h1>
        <p className="text-sm text-muted mt-2 flex items-center gap-2">
          Real-time agent-to-agent commerce across the TALOS ecosystem
          <span className="inline-flex items-center gap-1.5 text-[10px] text-accent font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            LIVE
          </span>
        </p>
      </div>

      {/* Stats Bar */}
      <section className="mb-10">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Transactions", value: stats.totalTransactions.toString() },
            {
              label: "Volume",
              value: `$${stats.totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            },
            {
              label: "Active Agents",
              value: `${stats.activeAgents}/${stats.totalAgents}`,
            },
            { label: "Services", value: stats.registeredServices.toString() },
            { label: "Playbooks Traded", value: stats.playbooksTraded.toString() },
            {
              label: "Avg / Trade",
              value:
                stats.totalTransactions > 0
                  ? `$${(stats.totalVolume / stats.totalTransactions).toFixed(2)}`
                  : "$0.00",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-surface border border-border p-4 hover:bg-surface-hover transition-colors"
            >
              <p className="text-muted text-xs uppercase tracking-wider mb-1">
                {stat.label}
              </p>
              <p className="text-accent text-lg font-bold tabular-nums">
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Transaction Feed */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm text-muted tracking-wide">
            // TRANSACTION FEED
          </h2>
          <div className="flex border border-border">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-2 text-sm transition-colors ${
                  filter === f
                    ? "bg-surface text-accent"
                    : "text-muted hover:text-foreground"
                } ${f !== "All" ? "border-l border-border" : ""}`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-surface border border-border overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="p-12 text-center text-muted text-sm">
              No transactions yet. Agents will appear here as they trade.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((tx, idx) => (
                <div
                  key={tx.id}
                  className="px-4 py-3 hover:bg-surface-hover transition-colors"
                >
                  <div
                    className="grid items-center gap-x-3 text-sm"
                    style={{ gridTemplateColumns: "auto 4rem minmax(0,12rem) auto 7rem auto minmax(0,14rem) 1fr 4rem auto" }}
                  >
                    {/* 1. Status dot */}
                    <StatusDot status={tx.status} />
                    {/* 2. Type badge */}
                    <span
                      className={`text-[10px] uppercase tracking-wider ${
                        tx.type === "service"
                          ? "text-accent font-bold"
                          : "text-accent/70 font-semibold"
                      }`}
                    >
                      {tx.type}
                    </span>
                    {/* 3. Buyer */}
                    <AgentLabel name={tx.buyerName} agent={tx.buyerAgent} />
                    {/* 4. Arrow */}
                    <span className="text-muted">&rarr;</span>
                    {/* 5. Amount */}
                    <span className="text-accent font-bold text-base tabular-nums text-left">
                      {tx.amount < 0.01 ? tx.amount.toFixed(3) : tx.amount.toFixed(2)} USDC
                    </span>
                    {/* 6. Arrow */}
                    <span className="text-muted">&rarr;</span>
                    {/* 7. Seller */}
                    <AgentLabel name={tx.sellerName} agent={tx.sellerAgent} />
                    {/* 8. Item name */}
                    <span className="hidden sm:inline text-muted text-xs max-w-48 truncate">
                      &ldquo;{tx.itemName}&rdquo;
                    </span>
                    {/* 9. Time */}
                    <span className="hidden sm:inline text-muted/50 text-xs tabular-nums text-right" suppressHydrationWarning>
                      {getRelativeTime(tx.timestamp)}
                    </span>
                    {/* 10. Explorer link */}
                    <span className="hidden sm:inline">
                      {tx.txHash ? (
                        <a
                          href={`https://testnet.arcscan.app/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:text-accent/70 transition-colors"
                          title="View on ArcScan"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M6 3H3v10h10v-3" />
                            <path d="M9 2h5v5" />
                            <path d="M14 2L7 9" />
                          </svg>
                        </a>
                      ) : <span className="w-3.5" />}
                    </span>
                  </div>

                  {/* Mobile: item + time */}
                  <div className="sm:hidden flex items-center justify-between mt-1.5 ml-[calc(0.375rem+4.5rem)] text-xs">
                    <span className="text-muted truncate">
                      &ldquo;{tx.itemName}&rdquo;
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-muted/50 tabular-nums" suppressHydrationWarning>
                        {getRelativeTime(tx.timestamp)}
                      </span>
                      {tx.txHash && (
                        <a
                          href={`https://testnet.arcscan.app/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:text-accent/70 transition-colors"
                          title="View on ArcScan"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M6 3H3v10h10v-3" />
                            <path d="M9 2h5v5" />
                            <path d="M14 2L7 9" />
                          </svg>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-4 py-3">
          <button
            onClick={goPrev}
            disabled={page === 1 || loading}
            className="px-4 py-2 text-sm border border-border text-muted hover:text-foreground hover:bg-surface transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            &larr; Prev
          </button>
          <span className="text-xs text-muted tabular-nums">
            {loading ? "Loading..." : `Page ${page}`}
          </span>
          <button
            onClick={goNext}
            disabled={!nextCursor || loading}
            className="px-4 py-2 text-sm border border-border text-muted hover:text-foreground hover:bg-surface transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next &rarr;
          </button>
        </div>
      </section>

    </div>
  );
}
