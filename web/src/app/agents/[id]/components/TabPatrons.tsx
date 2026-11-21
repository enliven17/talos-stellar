"use client";

import type { TalosDetail } from "./types";
import { AgentEmptyState } from "@/components/agent-view-states";

interface TabPatronsProps {
  talos: TalosDetail;
  minRequired: number;
  address: string | undefined;
  isConnected: boolean;
  onBuyToken: () => void;
}

export function TabPatrons({
  talos,
  minRequired,
  address,
  isConnected,
  onBuyToken,
}: TabPatronsProps) {
  const totalPulse = talos.patrons.reduce((s, p) => s + p.pulseAmount, 0);
  const me = isConnected && address
    ? talos.patrons.find((p) => p.stellarPublicKey === address)
    : undefined;
  const myShare =
    totalPulse > 0 && me
      ? ((me.pulseAmount / totalPulse) * 100).toFixed(2)
      : "0";

  return (
    <div className="space-y-6">
      {/* My Holdings */}
      {isConnected && address && (
        <div className="bg-surface border border-accent/20 p-6">
          <div className="text-xs text-accent mb-4">[MY HOLDINGS]</div>
          {me ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-xs text-muted">
                  {talos.tokenSymbol} Held
                </div>
                <div className="text-lg font-bold text-accent mt-1">
                  {me.pulseAmount.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Network Share</div>
                <div className="text-lg font-bold text-foreground mt-1">
                  {myShare}%
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Role</div>
                <div className="text-lg font-bold text-foreground mt-1">
                  {me.role}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted">Status</div>
                <div
                  className={`text-lg font-bold mt-1 ${
                    me.status === "active" ? "text-green-400" : "text-muted"
                  }`}
                >
                  {me.status.toUpperCase()}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">
                You are not a patron yet. Buy at least{" "}
                {minRequired.toLocaleString()} {talos.tokenSymbol} to join.
              </p>
              <button
                onClick={onBuyToken}
                className="border border-accent/40 text-accent px-4 py-1.5 text-xs font-medium hover:bg-accent hover:text-background transition-colors"
              >
                Buy {talos.tokenSymbol}
              </button>
            </div>
          )}
        </div>
      )}

      {/* All Patrons table */}
      <div className="bg-surface border border-border">
        <div className="grid grid-cols-4 gap-4 px-4 py-3 border-b border-border text-xs text-muted">
          <span>Stellar Address</span>
          <span>Role</span>
          <span className="text-right">{talos.tokenSymbol} Amount</span>
          <span className="text-right">Share</span>
        </div>
        {talos.patrons.length === 0 ? (
          <AgentEmptyState kind="patrons" className="py-12" />
        ) : (
          talos.patrons.map((p, i) => (
            <div
              key={i}
              className={`grid grid-cols-4 gap-4 px-4 py-3 border-b border-border last:border-0 transition-colors text-sm ${
                p.stellarPublicKey === address
                  ? "bg-accent/5"
                  : "hover:bg-surface-hover"
              }`}
            >
              <span className="text-foreground font-mono text-xs truncate">
                {p.stellarPublicKey === address
                  ? "You"
                  : `${p.stellarPublicKey.slice(0, 8)}...${p.stellarPublicKey.slice(-4)}`}
              </span>
              <span
                className={`text-xs ${
                  p.role === "Creator"
                    ? "text-accent"
                    : p.role === "Treasury"
                      ? "text-yellow-400"
                      : "text-foreground"
                }`}
              >
                [{p.role.toUpperCase()}]
              </span>
              <span className="text-right text-foreground">
                {p.pulseAmount.toLocaleString()}
              </span>
              <span className="text-right text-muted">{p.share}%</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
