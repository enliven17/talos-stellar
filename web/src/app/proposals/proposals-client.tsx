"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useWallet } from "@/components/wallet-gate";

interface Proposal {
  id: string;
  talosId: string;
  talosName: string;
  type: string;
  title: string;
  description: string | null;
  amount: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  txHash: string | null;
  createdAt: string;
}

function getRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "text-yellow-400",
  approved: "text-green-400",
  rejected: "text-red-400",
};

const FILTERS = ["all", "pending", "approved", "rejected"] as const;
type Filter = (typeof FILTERS)[number];

export function ProposalsClient() {
  const { isConnected, address, connect } = useWallet();

  const [filter, setFilter] = useState<Filter>("all");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<Record<string, boolean>>({});

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    const url = f === "all" ? "/api/proposals" : `/api/proposals?status=${f}`;
    const res = await fetch(url);
    if (res.ok) setProposals(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(filter); }, [filter, load]);

  const handleVote = useCallback(
    async (proposal: Proposal, decision: "approved" | "rejected") => {
      if (!address) return;
      setVoting((v) => ({ ...v, [proposal.id]: true }));
      try {
        const res = await fetch(
          `/api/talos/${proposal.talosId}/approvals/${proposal.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: decision, decidedBy: address }),
          },
        );
        const data = await res.json();
        if (res.ok) {
          setProposals((prev) =>
            prev.map((p) =>
              p.id === proposal.id
                ? { ...p, status: decision, decidedBy: address, decidedAt: new Date().toISOString() }
                : p,
            ),
          );
        } else {
          alert(data.error || "Vote failed");
        }
      } finally {
        setVoting((v) => ({ ...v, [proposal.id]: false }));
      }
    },
    [address],
  );

  const pending = proposals.filter((p) => p.status === "pending").length;

  return (
    <div className="space-y-6">
      {/* Stats + filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-6 text-sm">
          <span className="text-muted">
            <span className="text-accent font-bold">{proposals.length}</span> total
          </span>
          <span className="text-muted">
            <span className="text-yellow-400 font-bold">{pending}</span> pending
          </span>
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs border transition-colors ${
                filter === f
                  ? "border-accent text-accent"
                  : "border-border text-muted hover:border-accent/50 hover:text-foreground"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Wallet prompt */}
      {!isConnected && (
        <div className="bg-surface border border-border px-5 py-4 flex items-center justify-between gap-4">
          <p className="text-sm text-muted">Connect your wallet to vote on pending proposals.</p>
          <button
            onClick={connect}
            className="bg-accent text-background px-4 py-1.5 text-xs font-medium hover:bg-foreground transition-colors shrink-0"
          >
            Connect Wallet
          </button>
        </div>
      )}

      {/* Proposal list */}
      {loading && (
        <div className="py-16 text-center text-muted text-sm">Loading proposals...</div>
      )}

      {!loading && proposals.length === 0 && (
        <div className="py-16 text-center text-muted text-sm">No proposals found.</div>
      )}

      {!loading &&
        proposals.map((p) => (
          <div key={p.id} className="bg-surface border border-border p-5 space-y-3">
            {/* Header row */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  {/* Talos name link */}
                  <Link
                    href={`/agents/${p.talosId}`}
                    className="text-xs text-muted hover:text-accent transition-colors border border-border px-2 py-0.5"
                  >
                    {p.talosName}
                  </Link>
                  <span className="text-xs border border-border px-2 py-0.5 text-muted uppercase">
                    {p.type}
                  </span>
                  <span className={`text-xs font-bold ${STATUS_STYLE[p.status] ?? "text-muted"}`}>
                    [{p.status.toUpperCase()}]
                  </span>
                </div>
                <h3 className="text-sm font-bold text-foreground">{p.title}</h3>
                {p.description && (
                  <p className="text-xs text-muted mt-1 leading-relaxed">{p.description}</p>
                )}
                {p.amount && (
                  <p className="text-xs text-accent mt-1 font-medium">
                    ${Number(p.amount).toFixed(2)} USDC
                  </p>
                )}
              </div>

              {/* Vote buttons — only for pending proposals when wallet connected */}
              {p.status === "pending" && isConnected && (
                <div className="flex gap-2 shrink-0">
                  <button
                    disabled={voting[p.id]}
                    onClick={() => handleVote(p, "approved")}
                    className="text-xs px-3 py-1.5 border border-green-400/30 text-green-400 hover:bg-green-400 hover:text-background transition-colors disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={voting[p.id]}
                    onClick={() => handleVote(p, "rejected")}
                    className="text-xs px-3 py-1.5 border border-red-400/30 text-red-400 hover:bg-red-400 hover:text-background transition-colors disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>

            {/* Footer row */}
            <div className="flex flex-wrap gap-4 text-xs text-muted/60">
              <span title={p.createdAt}>{getRelativeTime(p.createdAt)}</span>
              {p.decidedBy && (
                <span>
                  Decided by{" "}
                  <span className="font-mono">
                    {p.decidedBy.slice(0, 6)}...{p.decidedBy.slice(-4)}
                  </span>
                  {p.decidedAt && ` · ${getRelativeTime(p.decidedAt)}`}
                </span>
              )}
              {p.txHash && (
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${p.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-accent transition-colors"
                >
                  {p.txHash.slice(0, 8)}... ↗
                </a>
              )}
            </div>
          </div>
        ))}
    </div>
  );
}
