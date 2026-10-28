"use client";

import type { LaunchFormState } from "@/lib/schemas";
import { LAUNCH_CHANNELS } from "@/lib/schemas";
import { Field } from "./shared";

interface StepAgentProps {
  form: LaunchFormState;
  update: (key: keyof LaunchFormState, value: string | string[]) => void;
  nameAvailable: boolean | null;
  nameChecking: boolean;
  checkNameAvailability: (name: string) => void;
}

export function StepAgent({
  form,
  update,
  nameAvailable,
  nameChecking,
  checkNameAvailability,
}: StepAgentProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-accent mb-1">Prime Agent Setup</h2>
      <p className="text-sm text-muted mb-6">
        Configure your AI agent&apos;s personality and targets.
      </p>

      {/* Agent identity */}
      <div>
        <label className="block text-xs text-muted mb-2">
          Agent Identity (immutable)
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={form.agentName}
            onChange={(e) => {
              const v = e.target.value
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, "");
              update("agentName", v);
              checkNameAvailability(v);
            }}
            placeholder="e.g. marketbot"
            data-testid="launch-input-agent-identity"
            className="flex-1 bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
          />
          <span className="text-sm text-muted">.talos</span>
        </div>
        <div className="mt-1.5 text-xs">
          {nameChecking && <span className="text-muted">Checking...</span>}
          {!nameChecking &&
            nameAvailable === true &&
            form.agentName.length >= 3 && (
              <span className="text-accent font-bold">
                {form.agentName}.talos is available
              </span>
            )}
          {!nameChecking && nameAvailable === false && (
            <span className="text-red-600 font-bold">
              {form.agentName}.talos is taken
            </span>
          )}
          {!nameChecking &&
            nameAvailable === null &&
            form.agentName.length > 0 &&
            form.agentName.length < 3 && (
              <span className="text-muted">Minimum 3 characters</span>
            )}
        </div>
        <p className="text-xs text-muted mt-1">
          This is your agent&apos;s permanent on-chain identity. It cannot be
          changed after registration.
        </p>
      </div>

      <Field
        label="Persona"
        value={form.persona}
        onChange={(v) => update("persona", v)}
        placeholder="e.g. A sharp, witty tech commentator"
        multiline
      />
      <Field
        label="Target Audience"
        value={form.targetAudience}
        onChange={(v) => update("targetAudience", v)}
        placeholder="e.g. Indie developers building SaaS products"
      />

      {/* Tone */}
      <div>
        <label className="block text-xs text-muted mb-2">Tone</label>
        <select
          value={form.tone}
          onChange={(e) =>
            update("tone", e.target.value as LaunchFormState["tone"])
          }
          data-testid="launch-input-tone"
          className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
        >
          <option value="professional">Professional</option>
          <option value="casual">Casual</option>
          <option value="witty">Witty</option>
          <option value="technical">Technical</option>
        </select>
      </div>

      {/* Channels */}
      <div>
        <label className="block text-xs text-muted mb-2">GTM Channels</label>
        <div className="flex flex-wrap gap-2">
          {LAUNCH_CHANNELS.map((ch) => (
            <button
              key={ch}
              onClick={() => {
                const channels = form.channels.includes(ch)
                  ? form.channels.filter((c) => c !== ch)
                  : [...form.channels, ch];
                update("channels", channels);
              }}
              data-testid={`launch-channel-${ch
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")}`}
              className={`px-3 py-1.5 text-xs border transition-colors ${
                form.channels.includes(ch)
                  ? "border-accent text-accent bg-surface"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {ch}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
