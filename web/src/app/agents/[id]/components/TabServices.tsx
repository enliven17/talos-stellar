"use client";

import type { TalosDetail } from "./types";
import { JOB_STATUS_STYLES } from "./types";
import { AgentEmptyState } from "@/components/agent-view-states";

interface TabServicesProps {
  talos: TalosDetail;
  isConnected: boolean;
  onConnect: () => void;
  onRequestService: () => void;
}

export function TabServices({
  talos,
  isConnected,
  onConnect,
  onRequestService,
}: TabServicesProps) {
  if (!talos.service) {
    return (
      <div className="space-y-6">
        <AgentEmptyState kind="service" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Service card */}
      <div className="bg-surface border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs text-accent">[AVAILABLE SERVICE]</div>
          <span
            className={`text-xs ${
              talos.agentOnline ? "text-green-400" : "text-muted"
            }`}
          >
            {talos.agentOnline ? "[ACCEPTING REQUESTS]" : "[OFFLINE]"}
          </span>
        </div>
        <h3 className="text-lg font-bold text-foreground mb-2">
          {talos.service.name}
        </h3>
        {talos.service.description && (
          <p className="text-sm text-muted mb-4">{talos.service.description}</p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted text-xs">Price</span>
            <p className="text-accent font-bold mt-1">
              {talos.service.price} {talos.service.currency}
            </p>
          </div>
          <div>
            <span className="text-muted text-xs">Payment</span>
            <p className="text-foreground mt-1">x402 on Stellar</p>
          </div>
          <div>
            <span className="text-muted text-xs">Chains</span>
            <p className="text-foreground mt-1">
              {talos.service.chains.join(", ")}
            </p>
          </div>
          <div>
            <span className="text-muted text-xs">Wallet</span>
            <p className="text-foreground mt-1 font-mono text-xs truncate">
              {talos.service.stellarPublicKey}
            </p>
          </div>
        </div>
      </div>

      {/* Request Service */}
      {isConnected ? (
        <div className="bg-surface border border-accent/20 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-xs text-accent">[REQUEST SERVICE]</div>
            <span className="text-xs text-muted">
              Pay {talos.service.price} {talos.service.currency} · wallet
              signing required
            </span>
          </div>
          <p className="text-xs text-muted mb-4">
            Submit a job to this agent. Your USDC payment is sent on-chain and
            the agent processes your request.
          </p>
          <button
            onClick={onRequestService}
            disabled={!talos.agentOnline}
            className={`px-6 py-2.5 text-sm font-medium transition-colors ${
              talos.agentOnline
                ? "bg-accent text-background hover:bg-foreground"
                : "bg-surface text-muted border border-border cursor-not-allowed"
            }`}
          >
            {talos.agentOnline
              ? `Request — ${talos.service.price} USDC`
              : "Agent Offline"}
          </button>
        </div>
      ) : (
        <div className="bg-surface border border-border p-6 text-center">
          <p className="text-sm text-muted mb-4">
            Connect your wallet to request this service
          </p>
          <button
            onClick={onConnect}
            className="bg-accent text-background px-6 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
          >
            Connect Wallet
          </button>
        </div>
      )}

      {/* Integration guide */}
      <div className="bg-surface border border-border p-6">
        <div className="text-xs text-muted mb-4">[API INTEGRATION]</div>
        <p className="text-xs text-muted mb-4">
          Integrate programmatically — pay USDC on-chain, then call the jobs
          endpoint.
        </p>
        <div className="bg-background border border-border p-4 text-xs text-foreground overflow-x-auto font-mono space-y-1">
          <div className="text-green-400"># 1. Send USDC payment on Stellar</div>
          <div className="text-muted">
            destination: {talos.service.stellarPublicKey.slice(0, 12)}...
          </div>
          <div className="text-muted">
            amount: {talos.service.price} USDC
          </div>
          <div className="mt-3 text-green-400"># 2. Create job with txHash</div>
          <div className="text-muted">
            POST /api/talos/{talos.id}/jobs
          </div>
          <div className="mt-1">{"{"}</div>
          <div className="pl-4">&quot;buyerPublicKey&quot;: &quot;G...&quot;,</div>
          <div className="pl-4">
            &quot;txHash&quot;: &quot;&lt;stellar_tx_hash&gt;&quot;,
          </div>
          <div className="pl-4">
            &quot;payload&quot;: {"{"} &quot;request&quot;: &quot;your task
            here&quot; {"}"}
          </div>
          <div>{"}"}</div>
          <div className="mt-3 text-green-400"># 3. Poll for result</div>
          <div className="text-muted">
            GET /api/talos/{talos.id}/jobs?jobId=:id
          </div>
        </div>
      </div>

      {/* Recent jobs */}
      {talos.recentJobs.length > 0 && (
        <div className="bg-surface border border-border p-6">
          <div className="text-xs text-muted mb-4">[RECENT JOBS]</div>
          <div className="space-y-2">
            {talos.recentJobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between py-2 border-b border-border last:border-0 text-xs"
              >
                <div className="flex items-center gap-3">
                  <span className={JOB_STATUS_STYLES[job.status] ?? "text-muted"}>
                    [{job.status.toUpperCase()}]
                  </span>
                  <span className="text-foreground">{job.serviceName}</span>
                </div>
                <div className="flex items-center gap-4 text-muted">
                  <span>${job.amount}</span>
                  <span>{job.createdAt}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
