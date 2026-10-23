"use client";

import { useRef } from "react";
import type { TalosDetail } from "./types";
import { AgentAvatar } from "@/components/agent-avatar";

interface BuyTokenModalProps {
  talos: TalosDetail;
  buyAmount: string;
  buyStatus: "idle" | "buying" | "success" | "error";
  buyResult: { txHash: string; message: string } | null;
  onAmountChange: (v: string) => void;
  onBuy: () => void;
  onClose: () => void;
}

export function BuyTokenModal({
  talos,
  buyAmount,
  buyStatus,
  buyResult,
  onAmountChange,
  onBuy,
  onClose,
}: BuyTokenModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const priceNum = parseFloat(talos.pulsePrice.replace("$", "")) || 0;
  const buyQty = Math.max(0, parseInt(buyAmount, 10) || 0);
  const buyCost = Math.round(buyQty * priceNum * 100) / 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative bg-background border border-border w-full max-w-md mx-4 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="text-xs text-accent tracking-wider">
            [BUY ${talos.tokenSymbol}]
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground text-sm"
          >
            &times;
          </button>
        </div>

        {buyStatus === "success" && buyResult ? (
          /* Success state */
          <div className="px-6 py-8 text-center">
            <div className="w-12 h-12 mx-auto mb-4 border border-green-400/40 flex items-center justify-center text-green-400 text-lg">
              &#10003;
            </div>
            <p className="text-sm text-foreground mb-2">Purchase Complete</p>
            <p className="text-xs text-muted mb-4">{buyResult.message}</p>
            <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-6">
              tx: {buyResult.txHash.slice(0, 18)}...
              {buyResult.txHash.slice(-8)}
            </div>
            <button
              onClick={onClose}
              className="bg-accent text-background px-8 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          /* Purchase form */
          <div className="px-6 py-6 space-y-5">
            {/* Token info */}
            <div className="flex items-center gap-3">
              <AgentAvatar
                name={talos.agentName || talos.name}
                size={36}
              />
              <div>
                <div className="text-sm font-bold text-foreground">
                  {talos.name}
                </div>
                <div className="text-xs text-muted">
                  {talos.tokenSymbol} &middot; Fixed Price{" "}
                  {talos.pulsePrice}/token
                </div>
              </div>
            </div>

            {/* Amount input */}
            <div>
              <label className="text-xs text-muted block mb-1.5">
                Amount ({talos.tokenSymbol})
              </label>
              <input
                ref={inputRef}
                type="number"
                min={1}
                step={1}
                value={buyAmount}
                onChange={(e) => onAmountChange(e.target.value)}
                placeholder="e.g. 1000"
                className="w-full bg-surface border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/40 focus:outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2 mt-2">
                {[100, 1000, 10000].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => onAmountChange(String(preset))}
                    className="text-xs border border-border px-2 py-1 text-muted hover:text-accent hover:border-accent transition-colors"
                  >
                    {preset.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            {/* Cost breakdown */}
            <div className="bg-surface border border-border p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Token Price</span>
                <span className="text-foreground">
                  {talos.pulsePrice} USDC
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Quantity</span>
                <span className="text-foreground">
                  {buyQty.toLocaleString()} {talos.tokenSymbol}
                </span>
              </div>
              <div className="flex justify-between text-sm pt-2 border-t border-border">
                <span className="text-muted">Total Cost</span>
                <span className="text-accent font-bold">
                  ${buyCost.toFixed(2)} USDC
                </span>
              </div>
            </div>

            {/* Buy button */}
            <button
              onClick={onBuy}
              disabled={buyQty <= 0 || buyStatus === "buying"}
              className={`w-full py-3 text-sm font-medium transition-colors ${
                buyQty > 0
                  ? "bg-accent text-background hover:bg-foreground"
                  : "bg-surface text-muted border border-border cursor-not-allowed"
              }`}
            >
              {buyStatus === "buying"
                ? "Processing..."
                : buyQty > 0
                  ? `Buy ${buyQty.toLocaleString()} ${talos.tokenSymbol} for $${buyCost.toFixed(2)}`
                  : `Enter amount to buy`}
            </button>

            <p className="text-xs text-muted/50 text-center">
              Stellar testnet &mdash; real transaction, real tokens
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
