"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { CommerceNetworkTable, type CommerceNetworkEdge } from "./commerce-network-table";

const CommerceNetworkGraph = dynamic(
  () => import("./commerce-network-graph").then(module => module.CommerceNetworkGraph),
  { ssr: false, loading: () => <div className="h-[28rem] animate-pulse bg-border/30" role="status">Loading graph...</div> },
);

interface NetworkResponse {
  edges: CommerceNetworkEdge[];
  metadata: {
    windowDays: number;
    nodeCount: number;
    suppressedEdges: number;
    truncated: boolean;
  };
}

export function CommerceNetworkClient() {
  const [windowDays, setWindowDays] = useState(30);
  const [view, setView] = useState<"graph" | "table">("graph");
  const [data, setData] = useState<NetworkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/ecosystem-intelligence/network?window=${windowDays}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Unable to load commerce network (${response.status})`);
        return response.json() as Promise<NetworkResponse>;
      })
      .then(setData)
      .catch(cause => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Unable to load commerce network");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [windowDays]);

  function selectWindow(days: number) {
    if (days === windowDays) return;
    setLoading(true);
    setError(null);
    setWindowDays(days);
  }

  return (
    <section className="mb-10" aria-labelledby="commerce-network-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="commerce-network-heading" className="text-sm text-muted tracking-wide">AGENT COMMERCE NETWORK</h2>
          <p className="mt-1 text-xs text-muted">Completed jobs between agents; sparse pairings are hidden.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex border border-border" role="group" aria-label="Network time window">
            {[7, 30, 90].map(days => (
              <button
                key={days}
                type="button"
                aria-pressed={windowDays === days}
                onClick={() => selectWindow(days)}
                className={`px-3 py-1.5 text-xs ${windowDays === days ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
              >
                {days}d
              </button>
            ))}
          </div>
          <div className="flex border border-border" role="group" aria-label="Network display">
            <button
              type="button"
              aria-pressed={view === "graph"}
              onClick={() => setView("graph")}
              className={`px-3 py-1.5 text-xs ${view === "graph" ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
            >
              Graph
            </button>
            <button
              type="button"
              aria-pressed={view === "table"}
              onClick={() => setView("table")}
              className={`px-3 py-1.5 text-xs ${view === "table" ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      <div className="border border-border bg-surface p-4 sm:p-6">
        {loading && !data ? (
          <div className="h-40 animate-pulse bg-border/30" role="status">Loading commerce network...</div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-accent" role="alert">{error}</p>
        ) : data ? (
          <>
            <p className="mb-3 text-xs text-muted" aria-live="polite">
              {data.metadata.nodeCount} agents · {data.edges.length} relationships · {windowDays} days
              {data.metadata.truncated ? " · showing highest-volume relationships" : ""}
            </p>
            {view === "graph" ? (
              <CommerceNetworkGraph edges={data.edges} />
            ) : (
              <CommerceNetworkTable edges={data.edges} />
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}