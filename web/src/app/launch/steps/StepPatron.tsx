"use client";

import type { LaunchFormState } from "@/lib/schemas";

interface StepPatronProps {
  form: LaunchFormState;
  address: string | undefined;
}

export function StepPatron({ form, address }: StepPatronProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">
        Patron Configuration
      </h2>
      <p className="text-sm text-muted mb-6">
        The Creator is your Stellar public key. It is permanently linked to this
        TALOS and cannot be changed.
      </p>

      <div>
        <label className="block text-xs text-muted mb-2">
          Creator Public Key (Stellar)
        </label>
        <div
          data-testid="creator-wallet-display"
          className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground/70 font-mono select-all break-all"
        >
          {form.creatorWallet || address || "—"}
        </div>
        <p className="text-xs text-muted mt-1">
          This Stellar public key will be registered as the TALOS Creator
          on-chain.
        </p>
      </div>

      <div className="p-4 border border-border bg-background">
        <div className="text-xs text-accent mb-2">[REVENUE MODEL]</div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Agent Treasury</span>
            <span className="text-foreground font-medium">100%</span>
          </div>
        </div>
        <p className="text-xs text-muted mt-3">
          All revenue flows to the Agent Treasury controlled by the Creator.
        </p>
      </div>
    </div>
  );
}
