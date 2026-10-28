"use client";

import type { LaunchFormState } from "@/lib/schemas";
import { Field } from "./shared";

interface StepKernelProps {
  form: LaunchFormState;
  update: (key: keyof LaunchFormState, value: string | string[]) => void;
}

export function StepKernel({ form, update }: StepKernelProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">Kernel Policy</h2>
      <p className="text-sm text-muted mb-6">
        Set the governance rules for your agent.
      </p>

      <Field
        label="Approval Threshold (USDC)"
        value={form.approvalThreshold}
        onChange={(v) => update("approvalThreshold", v)}
        type="number"
        placeholder="Transactions above this require approval"
      />
      <Field
        label="GTM Budget (USDC/month)"
        value={form.gtmBudget}
        onChange={(v) => update("gtmBudget", v)}
        type="number"
        placeholder="Monthly budget for GTM activities"
      />
    </div>
  );
}
