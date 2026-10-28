"use client";

import type { TalosDetail } from "./types";
import { AgentAvailabilityBadge } from "@/components/agent-availability-badge";

interface TabAgentProps {
  talos: TalosDetail;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border last:border-0">
      <span className="text-muted text-xs">{label}</span>
      <span className="text-foreground text-right max-w-[60%]">{value}</span>
    </div>
  );
}

export function TabAgent({ talos }: TabAgentProps) {
  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="text-xs text-muted">[PRIME AGENT STATUS]</div>
          <AgentAvailabilityBadge
            agentOnline={talos.agentOnline}
            agentLastSeen={talos.agentLastSeen}
            status={talos.status}
            size="sm"
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted text-xs">Posts Today</span>
            <p className="text-foreground mt-1">
              {talos.agentStats.postsToday}
            </p>
          </div>
          <div>
            <span className="text-muted text-xs">Replies Today</span>
            <p className="text-foreground mt-1">
              {talos.agentStats.repliesToday}
            </p>
          </div>
          <div>
            <span className="text-muted text-xs">Researches Today</span>
            <p className="text-foreground mt-1">
              {talos.agentStats.researchesToday}
            </p>
          </div>
          <div>
            <span className="text-muted text-xs">Jobs Today</span>
            <p className="text-foreground mt-1">
              {talos.jobStats.jobsToday}
            </p>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="bg-surface border border-border p-6">
        <div className="text-xs text-muted mb-4">[AGENT CONFIGURATION]</div>
        <div className="space-y-4 text-sm">
          <Row label="Persona" value={talos.persona} />
          <Row label="Target Audience" value={talos.targetAudience} />
          <Row label="Channels" value={talos.channels.join(", ")} />
        </div>
      </div>

      {/* Local execution */}
      <div className="bg-surface border border-border p-6">
        <div className="text-xs text-muted mb-4">[LOCAL EXECUTION]</div>
        <div className="bg-background border border-border p-4 text-xs text-foreground space-y-1 overflow-x-auto font-mono">
          <div className="text-green-400">$ talos-agent status</div>
          <div className="text-muted mt-2">TALOS:     {talos.name}</div>
          <div className="text-muted break-all">
            Asset:     {talos.stellarAssetCode || talos.tokenSymbol}
          </div>
          <div className="text-muted">Network:   Stellar</div>
          <div className="text-muted">
            Status:    {talos.agentOnline ? "ONLINE" : "OFFLINE"}
          </div>
          {talos.service && (
            <>
              <div className="text-muted">Service:   {talos.service.name}</div>
              <div className="text-muted">
                Price:     {talos.service.price} {talos.service.currency}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
