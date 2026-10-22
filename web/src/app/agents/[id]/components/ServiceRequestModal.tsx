"use client";

import type React from "react";
import type { TalosDetail } from "./types";

interface ServiceRequestModalProps {
  talos: TalosDetail;
  servicePayload: string;
  serviceStatus: "idle" | "paying" | "success" | "error";
  serviceResult: {
    jobId: string;
    txHash: string;
    result?: Record<string, unknown>;
    status?: string;
  } | null;
  serviceError?: { message: string; retryable: boolean; retryAfterMs?: number } | null;
  retryCountdown?: number;
  retryIntervalRef?: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  onPayloadChange: (v: string) => void;
  onRequest: () => void;
  onClose: () => void;
  onRetry?: () => void;
}

export function ServiceRequestModal({
  talos,
  servicePayload,
  serviceStatus,
  serviceResult,
  serviceError,
  retryCountdown = 0,
  onPayloadChange,
  onRequest,
  onClose,
  onRetry,
}: ServiceRequestModalProps) {
  if (!talos.service) return null;

  const closable = serviceStatus !== "paying";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => closable && onClose()}
      />
      <div className="relative bg-background border border-border w-full max-w-md mx-4 p-0">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="text-xs text-accent tracking-wider">
            [REQUEST SERVICE]
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground text-sm"
          >
            &times;
          </button>
        </div>

        {serviceStatus === "success" && serviceResult ? (
          <div className="px-6 py-8 text-center">
            <div className="w-12 h-12 mx-auto mb-4 border border-green-400/40 flex items-center justify-center text-green-400 text-lg">
              &#10003;
            </div>
            <p className="text-sm text-foreground mb-2">Job Submitted</p>
            <p className="text-xs text-muted mb-4">
              The agent will process your request. Poll for results using your
              job ID.
            </p>
            <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-2">
              job: {serviceResult.jobId}
            </div>
            <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-6">
              tx: {serviceResult.txHash.slice(0, 18)}...
              {serviceResult.txHash.slice(-8)}
            </div>
            {serviceResult.status === "completed" && serviceResult.result ? (
              <div className="bg-surface border border-accent/20 p-4 text-left mb-4">
                <div className="text-xs text-accent mb-2">[RESULT]</div>
                <pre className="text-xs text-foreground overflow-x-auto whitespace-pre-wrap font-mono max-h-48">
                  {JSON.stringify(serviceResult.result, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="text-xs text-muted mb-4">
                Poll for result:{" "}
                <span className="font-mono">
                  GET /api/talos/{talos.id}/jobs?jobId={serviceResult.jobId}
                </span>
              </div>
            )}
            <button
              onClick={onClose}
              className="bg-accent text-background px-8 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-6 py-6 space-y-5">
            <div>
              <div className="text-sm font-bold text-foreground">
                {talos.service.name}
              </div>
              {talos.service.description && (
                <p className="text-xs text-muted mt-1">
                  {talos.service.description}
                </p>
              )}
            </div>

            {/* Inline error with retry guidance */}
            {serviceStatus === "error" && serviceError && (
              <div className="bg-red-950/30 border border-red-800/50 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <span className="text-red-400 text-xs font-bold shrink-0">[ERROR]</span>
                  <p className="text-xs text-red-300 leading-relaxed">{serviceError.message}</p>
                </div>
                {serviceError.retryable ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted">
                      This is a transient network error — the transaction did not reach the network. You can safely retry.
                    </p>
                    <button
                      onClick={onRetry}
                      disabled={retryCountdown > 0}
                      className="w-full py-2 text-xs font-medium border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {retryCountdown > 0 ? `Retry in ${retryCountdown}s…` : "Retry Purchase"}
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    This error cannot be retried. Your payment may have been submitted — check your wallet and contact support if needed.
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="text-xs text-muted block mb-1.5">
                Request / Payload (optional JSON or plain text)
              </label>
              <textarea
                rows={4}
                value={servicePayload}
                onChange={(e) => onPayloadChange(e.target.value)}
                placeholder={`{"request": "describe what you want the agent to do"}`}
                className="w-full bg-surface border border-border px-4 py-2.5 text-xs text-foreground placeholder:text-muted/40 focus:outline-none focus:border-accent font-mono resize-none"
              />
            </div>

            <div className="bg-surface border border-border p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Service Price</span>
                <span className="text-accent font-bold">
                  {talos.service.price} {talos.service.currency}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Payment</span>
                <span className="text-foreground">
                  Stellar · wallet signing
                </span>
              </div>
            </div>

            <button
              onClick={onRequest}
              disabled={serviceStatus === "paying" || retryCountdown > 0}
              className="w-full py-3 text-sm font-medium bg-accent text-background hover:bg-foreground transition-colors disabled:opacity-50"
            >
              {serviceStatus === "paying"
                ? "Processing payment..."
                : `Pay ${talos.service.price} USDC & Submit Job`}
            </button>

            <p className="text-xs text-muted/50 text-center">
              USDC is transferred on-chain before job creation
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
