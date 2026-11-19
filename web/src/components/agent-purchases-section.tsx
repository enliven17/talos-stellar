"use client";

/**
 * Owner-only view of the services a TALOS has bought, with status, price and
 * links to each result.
 *
 * Purchases are owner-scoped, so the section authenticates with a wallet
 * ownership proof (the same `x-talos-owner-*` header contract used by the
 * scoped API-key panel, re-scoped to the `purchases` resource) and pages
 * newest-first with a keyset cursor.
 *
 * Failed purchases reuse the retry affordance from the failed-purchase
 * recovery flow so an owner can immediately re-attempt from the provider.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AgentEmptyState } from "@/components/agent-view-states";
import { createOwnerProofMessage } from "@/lib/api-key-owner-message";

const PAGE_SIZE = 20;

export interface Purchase {
  id: string;
  providerId: string;
  providerName: string;
  serviceName: string;
  status: string;
  price: number;
  txHash: string | null;
  hasResult: boolean;
  resultUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface PurchasesResponse {
  purchases: Purchase[];
  nextCursor: string | null;
}

export interface AgentPurchasesSectionProps {
  talosId: string;
  isOwner: boolean;
  address: string | null;
  signMessage: (message: string) => Promise<string>;
  connect?: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  completed: "text-accent font-bold",
  pending: "text-muted",
  in_progress: "text-yellow-400",
  failed: "text-red-600",
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function AgentPurchasesSection({
  talosId,
  isOwner,
  address,
  signMessage,
  connect,
}: AgentPurchasesSectionProps) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const message = createOwnerProofMessage(talosId, "purchases", "GET");
    const signature = await signMessage(message);
    return {
      "x-talos-owner-address": address ?? "",
      "x-talos-owner-message": message,
      "x-talos-owner-signature": signature,
    };
  }, [address, signMessage, talosId]);

  const load = useCallback(async () => {
    if (!isOwner || !address) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await ownerHeaders();
      const res = await fetch(`/api/talos/${talosId}/purchases?limit=${PAGE_SIZE}`, {
        headers,
        cache: "no-store",
      });
      const data = (await res.json()) as PurchasesResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not load purchases");
      setPurchases(data.purchases);
      setCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load purchases");
    } finally {
      setLoading(false);
    }
  }, [address, isOwner, ownerHeaders, talosId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const headers = await ownerHeaders();
      const res = await fetch(
        `/api/talos/${talosId}/purchases?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
        { headers, cache: "no-store" },
      );
      const data = (await res.json()) as PurchasesResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Could not load purchases");
      setPurchases((prev) => [...prev, ...data.purchases]);
      setCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load purchases");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, ownerHeaders, talosId]);

  if (!address) {
    return (
      <AgentEmptyState
        kind="generic"
        testId="purchases-connect"
        title="Connect the owner wallet"
        description="Connect the agent owner's wallet to view the services this agent has bought."
        action={
          connect ? (
            <button
              type="button"
              onClick={connect}
              className="bg-accent text-background px-6 py-2 text-sm font-medium hover:bg-foreground transition-colors"
            >
              Connect Wallet
            </button>
          ) : undefined
        }
      />
    );
  }

  if (!isOwner) {
    return (
      <AgentEmptyState
        kind="generic"
        testId="purchases-locked"
        title="Owner access required"
        description="Only the agent owner can view this agent's purchases."
      />
    );
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading purchases…</p>;
  }

  if (error && purchases.length === 0) {
    return (
      <div role="alert" className="bg-surface border border-border p-6 text-center">
        <p className="text-sm text-red-400 mb-4">{error}</p>
        <button
          type="button"
          onClick={load}
          className="border border-accent text-accent px-4 py-2 text-xs hover:bg-accent hover:text-background transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (purchases.length === 0) {
    return (
      <AgentEmptyState
        kind="generic"
        testId="purchases-empty"
        title="No purchases yet"
        description="Services this agent buys from other agents will appear here, with their status and results."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border divide-y divide-border">
        {purchases.map((p) => (
          <div key={p.id} className="p-4" data-testid={`purchase-${p.id}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-bold text-foreground truncate">
                  {p.serviceName}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  from{" "}
                  <Link
                    href={`/agents/${p.providerId}`}
                    className="text-accent hover:text-foreground transition-colors"
                  >
                    {p.providerName}
                  </Link>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm text-accent font-bold">${p.price.toFixed(2)}</div>
                <div className={`text-xs uppercase ${STATUS_STYLES[p.status] ?? "text-muted"}`}>
                  {p.status.replace("_", " ")}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted">
              <span title={p.createdAt}>Purchased {formatTimestamp(p.createdAt)}</span>
              <span title={p.updatedAt}>Updated {formatTimestamp(p.updatedAt)}</span>
              {p.hasResult ? (
                <Link
                  href={p.resultUrl}
                  prefetch={false}
                  className="text-accent hover:text-foreground transition-colors"
                >
                  View result &rarr;
                </Link>
              ) : (
                <span className="text-muted/60">No result yet</span>
              )}
            </div>

            {p.status === "failed" && (
              <div className="bg-red-950/30 border border-red-800/50 p-3 mt-3 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-red-400 text-xs font-bold shrink-0">[FAILED]</span>
                  <p className="text-xs text-red-300 leading-relaxed">
                    This purchase did not complete. Your payment may have been submitted —
                    check your wallet before retrying.
                  </p>
                </div>
                <Link
                  href={`/agents/${p.providerId}`}
                  className="inline-block text-xs px-3 py-1.5 border border-accent text-accent hover:bg-accent hover:text-background transition-colors"
                >
                  Retry purchase
                </Link>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {cursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="text-xs px-4 py-2 border border-border text-muted hover:border-accent hover:text-accent transition-colors disabled:opacity-40"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
