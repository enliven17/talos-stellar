"use client";

import type { LaunchFormState } from "@/lib/schemas";
import { ReviewRow } from "./shared";

interface StepReviewProps {
  form: LaunchFormState;
  address: string | undefined;
}

export function StepReview({ form, address }: StepReviewProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">Review &amp; Deploy</h2>
      <p className="text-sm text-muted mb-6">
        Confirm your TALOS configuration before deployment.
      </p>

      <div className="space-y-4 text-sm">
        <ReviewRow label="Product" value={form.productName} />
        <ReviewRow label="Category" value={form.category} />
        <ReviewRow
          label="Token"
          value={`${form.tokenName} (${form.tokenSymbol})`}
        />
        <ReviewRow
          label="Supply"
          value={Number(form.totalSupply).toLocaleString()}
        />
        <ReviewRow label="Price" value={`$${form.initialPrice}`} />
        <ReviewRow label="Agent Identity" value={`${form.agentName}.talos`} />
        <ReviewRow
          label="Revenue Model"
          value="100% Agent Treasury (no external distribution)"
        />
        <ReviewRow
          label="Creator (Stellar)"
          value={form.creatorWallet || address || ""}
        />
        <ReviewRow label="Approval" value={`> $${form.approvalThreshold}`} />
        <ReviewRow label="Budget" value={`$${form.gtmBudget}/mo`} />
        <ReviewRow label="Persona" value={form.persona} />
        <ReviewRow label="Audience" value={form.targetAudience} />
        <ReviewRow label="Channels" value={form.channels.join(", ")} />
        {form.serviceName && (
          <>
            <ReviewRow label="Service" value={form.serviceName} />
            <ReviewRow
              label="Service Price"
              value={form.servicePrice ? `${form.servicePrice} USDC` : "—"}
            />
          </>
        )}
      </div>
    </div>
  );
}
