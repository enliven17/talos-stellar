"use client";

import type { TalosDetail, Approval } from "./types";
import { AgentLifecyclePanel } from "@/components/agent-lifecycle-panel";
import { AgentEmptyState } from "@/components/agent-view-states";

interface TabGovernanceProps {
  talos: TalosDetail;
  address: string | undefined;
  isConnected: boolean;
  isPatron: boolean;
  approvals: Approval[];
  approvalsLoaded: boolean;
  proposeOpen: boolean;
  proposeForm: {
    type: string;
    title: string;
    description: string;
    amount: string;
  };
  proposeLoading: boolean;
  onLoadApprovals: () => void;
  onVote: (approvalId: string, decision: "approved" | "rejected") => void;
  onOpenPropose: () => void;
  onClosePropose: () => void;
  onProposeFormChange: (
    field: "type" | "title" | "description" | "amount",
    value: string,
  ) => void;
  onPropose: () => void;
}

export function TabGovernance({
  talos,
  address,
  isConnected,
  isPatron,
  approvals,
  approvalsLoaded,
  proposeOpen,
  proposeForm,
  proposeLoading,
  onLoadApprovals,
  onVote,
  onOpenPropose,
  onClosePropose,
  onProposeFormChange,
  onPropose,
}: TabGovernanceProps) {
  return (
    <div className="space-y-6">
      {/* Lifecycle state, durable job progress, and transition history */}
      <AgentLifecyclePanel talosId={talos.id} />

      {/* Header + controls */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">
          {approvals.length} proposals total
        </div>
        <div className="flex gap-2">
          {!approvalsLoaded && (
            <button
              onClick={onLoadApprovals}
              className="border border-border px-4 py-1.5 text-xs text-muted hover:text-accent hover:border-accent transition-colors"
            >
              Load proposals
            </button>
          )}
          {isConnected && isPatron && (
            <button
              onClick={onOpenPropose}
              className="bg-accent text-background px-4 py-1.5 text-xs font-medium hover:bg-foreground transition-colors"
            >
              + Propose Action
            </button>
          )}
        </div>
      </div>

      {/* Propose form modal */}
      {proposeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={onClosePropose}
          />
          <div className="relative bg-background border border-border w-full max-w-md mx-4 p-6 space-y-4">
            <div className="text-xs text-accent mb-2">[NEW PROPOSAL]</div>
            <div>
              <label className="text-xs text-muted block mb-1">Type</label>
              <select
                value={proposeForm.type}
                onChange={(e) => onProposeFormChange("type", e.target.value)}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
              >
                {["transaction", "strategy", "policy", "channel"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Title *</label>
              <input
                value={proposeForm.title}
                onChange={(e) => onProposeFormChange("title", e.target.value)}
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
                placeholder="Short description of the action"
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Details</label>
              <textarea
                rows={3}
                value={proposeForm.description}
                onChange={(e) =>
                  onProposeFormChange("description", e.target.value)
                }
                className="w-full bg-surface border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent resize-none"
                placeholder="Explain the rationale..."
              />
            </div>
            {proposeForm.type === "transaction" && (
              <div>
                <label className="text-xs text-muted block mb-1">
                  Amount (USDC)
                </label>
                <input
                  type="number"
                  value={proposeForm.amount}
                  onChange={(e) =>
                    onProposeFormChange("amount", e.target.value)
                  }
                  className="w-full bg-surface border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
                  placeholder="0.00"
                />
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={onClosePropose}
                className="flex-1 border border-border py-2 text-sm text-muted hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onPropose}
                disabled={!proposeForm.title || proposeLoading}
                className="flex-1 bg-accent text-background py-2 text-sm font-medium hover:bg-foreground transition-colors disabled:opacity-50"
              >
                {proposeLoading ? "Submitting..." : "Submit Proposal"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {approvalsLoaded && approvals.length === 0 && (
        <AgentEmptyState kind="proposals" className="py-16" />
      )}

      {/* Approvals list */}
      {approvals.map((a) => (
        <div key={a.id} className="bg-surface border border-border p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs border border-border px-2 py-0.5 text-muted uppercase">
                  {a.type}
                </span>
                <span
                  className={`text-xs font-bold ${
                    a.status === "pending"
                      ? "text-yellow-400"
                      : a.status === "approved"
                        ? "text-green-400"
                        : "text-red-400"
                  }`}
                >
                  [{a.status.toUpperCase()}]
                </span>
              </div>
              <h4 className="text-sm font-bold text-foreground">{a.title}</h4>
              {a.description && (
                <p className="text-xs text-muted mt-1">{a.description}</p>
              )}
              {a.amount && (
                <p className="text-xs text-accent mt-1">
                  ${Number(a.amount).toFixed(2)} USDC
                </p>
              )}
            </div>
            {a.status === "pending" && isConnected && isPatron && (
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => onVote(a.id, "approved")}
                  className="text-xs px-3 py-1.5 border border-green-400/30 text-green-400 hover:bg-green-400 hover:text-background transition-colors"
                >
                  Approve
                </button>
                <button
                  onClick={() => onVote(a.id, "rejected")}
                  className="text-xs px-3 py-1.5 border border-red-400/30 text-red-400 hover:bg-red-400 hover:text-background transition-colors"
                >
                  Reject
                </button>
              </div>
            )}
          </div>
          <div className="text-xs text-muted/60 flex gap-4">
            <span>{new Date(a.createdAt).toLocaleDateString()}</span>
            {a.decidedBy && (
              <span>Decided by {a.decidedBy.slice(0, 8)}...</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
