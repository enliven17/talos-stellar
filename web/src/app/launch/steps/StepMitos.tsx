"use client";

import type { LaunchFormState } from "@/lib/schemas";
import { Field } from "./shared";

interface StepMitosProps {
  form: LaunchFormState;
  update: (key: keyof LaunchFormState, value: string | string[]) => void;
}

export function StepMitos({ form, update }: StepMitosProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">
        Mitos Configuration
      </h2>
      <p className="text-sm text-muted mb-6">
        Configure your TALOS&apos;s Mitos token on Stellar.
      </p>

      <Field
        label="Token Name"
        value={form.tokenName}
        onChange={(v) => update("tokenName", v)}
        placeholder="e.g. ImageGen Mitos"
      />

      <div>
        <Field
          label="Token Symbol (Stellar Asset Code)"
          value={form.tokenSymbol}
          onChange={(v) =>
            update(
              "tokenSymbol",
              v
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 8),
            )
          }
          placeholder="e.g. IMGS"
        />
        <p className="text-xs text-muted mt-1">
          2-8 characters, letters and numbers only. Used as Stellar asset code.
        </p>
      </div>

      <div>
        <Field
          label="Total Supply"
          value={form.totalSupply}
          onChange={(v) => update("totalSupply", v)}
          type="number"
        />
        <p className="text-xs text-muted mt-1">Max 100,000,000</p>
      </div>

      <div>
        <Field
          label="Initial Price (USDC)"
          value={form.initialPrice}
          onChange={(v) => update("initialPrice", v)}
          type="number"
        />
        <p className="text-xs text-muted mt-1">
          Price per Pulse token in USDC on Stellar
        </p>
      </div>
    </div>
  );
}
