"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@/components/wallet-gate";
import type {
  LifecycleAction,
  LifecycleChecklist,
  LifecycleObligation,
  LifecycleNextAction,
} from "@/lib/governance/lifecycle";

export interface AgentLifecycleChecklistProps {
  talosId: string;
  checklist?: LifecycleChecklist | null;
  onActionClick?: (action: LifecycleAction) => void;
  isOwner?: boolean;
}

export function AgentLifecycleChecklist({
  talosId,
  checklist: initialChecklist,
  onActionClick,
  isOwner: isOwnerProp,
}: AgentLifecycleChecklistProps) {
  const { address } = useWallet();
  const [data, setData] = useState<LifecycleChecklist | null>(initialChecklist ?? null);
  const [loading, setLoading] = useState(!initialChecklist);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialChecklist) {
      setData(initialChecklist);
      setLoading(false);
    }
  }, [initialChecklist]);

  const fetchChecklist = useCallback(async () => {
    if (initialChecklist) return;
    setLoading(true);
    setError(null);
    try {
      const viewerParam = address ? `?viewer=${encodeURIComponent(address)}` : "";
      const res = await fetch(`/api/talos/${talosId}/retire${viewerParam}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else if (res.status === 401 || res.status === 403) {
        // Fall back to lifecycle endpoint if retire route rejects non-owner
        const lifeRes = await fetch(`/api/talos/${talosId}/lifecycle${viewerParam}`, {
          cache: "no-store",
        });
        if (lifeRes.ok) {
          const lifeJson = await lifeRes.json();
          if (lifeJson.checklist) {
            setData(lifeJson.checklist);
          }
        } else {
          const errBody = await res.json().catch(() => ({}));
          setError(errBody.error || "Unable to load lifecycle checklist");
        }
      } else {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error || "Unable to load lifecycle checklist");
      }
    } catch {
      setError("Network error loading checklist");
    } finally {
      setLoading(false);
    }
  }, [talosId, address, initialChecklist]);

  useEffect(() => {
    if (!initialChecklist) {
      fetchChecklist();
    }
  }, [fetchChecklist, initialChecklist]);

  if (loading) {
    return (
      <div
        className="bg-surface border border-border p-4 text-xs text-muted"
        data-testid="lifecycle-checklist-loading"
      >
        Loading lifecycle checklist…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="bg-surface border border-border p-4 text-xs text-muted"
        data-testid="lifecycle-checklist-error"
      >
        <span className="text-yellow-500">[NOTICE]</span> {error}
      </div>
    );
  }

  if (!data) return null;

  const isOwner = isOwnerProp ?? data.isOwner;
  const hasBlocking = data.obligations.some((o) => o.blocking && !o.satisfied);
  const isRetired = data.state === "retired";

  return (
    <section
      aria-label="Agent lifecycle checklist"
      className="bg-surface border border-border p-5 space-y-4"
      data-testid="lifecycle-checklist"
    >
      {/* Header and readiness status */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold text-accent tracking-wider uppercase">
              [OWNER LIFECYCLE CHECKLIST]
            </h3>
            <span
              className={`text-[10px] px-2 py-0.5 border font-mono uppercase ${
                isRetired
                  ? "border-muted text-muted"
                  : data.canRetire
                    ? "border-green-400/40 text-green-400 bg-green-950/20"
                    : hasBlocking
                      ? "border-yellow-400/40 text-yellow-400 bg-yellow-950/20"
                      : "border-border text-foreground"
              }`}
              data-testid="checklist-readiness-badge"
            >
              {isRetired
                ? "Retired"
                : data.canRetire
                  ? "Ready for Retirement"
                  : hasBlocking
                    ? "Obligations Pending"
                    : "Settled"}
            </span>
          </div>
          <p className="text-xs text-muted mt-1">
            {isRetired
              ? "Agent has been permanently retired. All records and history are preserved."
              : data.canRetire
                ? "All blocking obligations are cleared. Agent is eligible for permanent retirement."
                : "Review blocking obligations and available next actions for this agent."}
          </p>
        </div>
        {isOwner ? (
          <span className="text-[11px] font-mono text-muted border border-border px-2 py-1">
            Owner Verified
          </span>
        ) : (
          <span
            className="text-[11px] font-mono text-yellow-500/80 border border-yellow-500/30 px-2 py-1"
            data-testid="lifecycle-non-owner-notice"
          >
            Read-Only: You are viewing in read-only mode
          </span>
        )}
      </div>

      {/* Obligations Checklist */}
      <div className="space-y-2">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">
          Obligations &amp; Prerequisites
        </h4>
        <ul className="space-y-2" data-testid="checklist-obligations-list">
          {data.obligations.map((ob: LifecycleObligation) => (
            <li
              key={ob.id}
              className={`p-3 border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                ob.satisfied
                  ? "border-border/60 bg-background/40"
                  : ob.blocking
                    ? "border-yellow-500/40 bg-yellow-950/10"
                    : "border-border bg-background"
              }`}
              data-testid={`obligation-${ob.id}`}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={`font-mono text-xs font-bold mt-0.5 ${
                    ob.satisfied
                      ? "text-green-400"
                      : ob.blocking
                        ? "text-yellow-400"
                        : "text-muted"
                  }`}
                  aria-hidden="true"
                >
                  {ob.satisfied ? "[✓]" : "[!]"}
                </span>
                <div>
                  <div className="font-medium text-foreground flex items-center gap-2">
                    <span>{ob.title}</span>
                    {typeof ob.count === "number" && ob.count > 0 && (
                      <span className="text-[10px] font-mono px-1.5 py-0.2 bg-border text-foreground rounded">
                        {ob.count}
                      </span>
                    )}
                  </div>
                  <p className="text-muted mt-0.5 leading-relaxed">{ob.description}</p>
                </div>
              </div>
              <div className="shrink-0 self-start sm:self-center">
                <span
                  className={`text-[10px] font-mono uppercase px-2 py-0.5 border ${
                    ob.satisfied
                      ? "border-green-400/40 text-green-400"
                      : ob.blocking
                        ? "border-yellow-400/50 text-yellow-400 font-bold"
                        : "border-border text-muted"
                  }`}
                >
                  {ob.satisfied ? "Cleared" : ob.blocking ? "Blocking" : "Pending"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Allowed Next Actions */}
      <div className="space-y-2 pt-2 border-t border-border">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">
          Allowed Next Actions
        </h4>
        {data.allowedNextActions.length === 0 ? (
          <p className="text-xs text-muted" data-testid="checklist-no-actions">
            {isRetired
              ? "No further actions permitted (terminal state)."
              : "No actions currently available for this role or state."}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2" data-testid="checklist-actions-list">
            {data.allowedNextActions.map((actionItem: LifecycleNextAction) => {
              const isBlocked = !actionItem.enabled;
              return (
                <div
                  key={actionItem.action}
                  className={`p-3 border flex flex-col justify-between gap-3 text-xs ${
                    actionItem.enabled
                      ? "border-border bg-background"
                      : "border-border/40 bg-surface/50 opacity-70"
                  }`}
                  data-testid={`action-${actionItem.action}`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-foreground font-mono">
                        {actionItem.label}
                      </span>
                      <span
                        className={`text-[10px] uppercase font-mono px-1.5 py-0.5 border ${
                          actionItem.enabled
                            ? "border-green-400/40 text-green-400"
                            : "border-border text-muted"
                        }`}
                      >
                        {actionItem.enabled ? "Available" : "Blocked"}
                      </span>
                    </div>
                    <p className="text-muted mt-1 leading-relaxed">
                      {actionItem.description}
                    </p>
                    {isBlocked && actionItem.blockingObligationIds.length > 0 && (
                      <p className="text-[11px] text-yellow-400/90 mt-1.5">
                        <span className="font-semibold">Blocked by:</span>{" "}
                        {actionItem.blockingObligationIds
                          .map((id) => {
                            const match = data.obligations.find((o) => o.id === id);
                            return match ? match.title : id;
                          })
                          .join(", ")}
                      </p>
                    )}
                  </div>
                  {onActionClick && (
                    <button
                      onClick={() => onActionClick(actionItem.action)}
                      disabled={!actionItem.enabled}
                      className={`text-xs px-3 py-1.5 border transition-colors self-start ${
                        actionItem.enabled
                          ? "border-accent text-accent hover:bg-accent hover:text-background"
                          : "border-border text-muted cursor-not-allowed"
                      }`}
                    >
                      {actionItem.label}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
