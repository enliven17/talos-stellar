"use client";

import type { LaunchFormState } from "@/lib/schemas";
import { Field } from "./shared";

interface StepProductProps {
  form: LaunchFormState;
  update: (key: keyof LaunchFormState, value: string | string[]) => void;
}

export function StepProduct({ form, update }: StepProductProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">Product Input</h2>
      <p className="text-sm text-muted mb-6">
        Register your product. Your Prime Agent will handle GTM and service
        delivery.
      </p>

      <Field
        label="Product Name"
        value={form.productName}
        onChange={(v) => update("productName", v)}
        placeholder="e.g. ImageGen Pro"
      />
      <Field
        label="Description"
        value={form.productDesc}
        onChange={(v) => update("productDesc", v)}
        placeholder="What does your product do? Who is it for?"
        multiline
      />

      <div>
        <label className="block text-xs text-muted mb-2">Category</label>
        <select
          value={form.category}
          onChange={(e) =>
            update("category", e.target.value as LaunchFormState["category"])
          }
          data-testid="launch-input-category"
          className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
        >
          <option value="marketing">Marketing</option>
          <option value="development">Development</option>
          <option value="research">Research</option>
          <option value="design">Design</option>
          <option value="finance">Finance</option>
          <option value="analytics">Analytics</option>
          <option value="operations">Operations</option>
          <option value="sales">Sales</option>
          <option value="support">Support</option>
          <option value="education">Education</option>
        </select>
      </div>

      {/* Commerce service (optional) */}
      <div className="pt-4 mt-2 border-t border-border">
        <div className="text-xs text-accent mb-1">[COMMERCE SERVICE]</div>
        <p className="text-xs text-muted mb-4">
          Define the paid service your agent offers to other agents via the x402
          protocol. Optional — you can add this later.
        </p>
        <div className="space-y-4">
          <Field
            label="Service Name"
            value={form.serviceName}
            onChange={(v) => update("serviceName", v)}
            placeholder="e.g. SEO Content Generation"
          />
          <Field
            label="Service Description"
            value={form.serviceDescription}
            onChange={(v) => update("serviceDescription", v)}
            placeholder="What does this service do? What input/output should callers expect?"
            multiline
          />
          <div>
            <label className="block text-xs text-muted mb-2">
              Price per Request (USDC)
            </label>
            <input
              type="number"
              value={form.servicePrice}
              onChange={(e) => update("servicePrice", e.target.value)}
              placeholder="e.g. 5.00"
              data-testid="launch-input-service-price"
              className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
