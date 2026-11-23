/**
 * Quota adjustment audit helpers.
 *
 * Every PATCH /api/talos/:id/quota records actor, reason, prior policy and new
 * policy. Free text is redacted so API credentials never reach the history.
 */

import type { QuotaConfig } from "@/lib/quota";

export interface QuotaPolicySnapshot {
  maxCount: number;
  windowSize: string;
  enabled: boolean;
  notes: string | null;
}

export const DEFAULT_ADJUSTMENT_REASON = "unspecified";
export const MAX_REASON_LENGTH = 500;
const REDACTED = "[REDACTED]";

/** Remove credential-looking material from free text. */
export function redactCredentials(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:tlk|sk|pk|key|api[_-]?key)[_-][A-Za-z0-9_-]{8,}/gi, REDACTED)
    .replace(/\b(api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, `$1=${REDACTED}`);
}

export function snapshotPolicy(
  config: Pick<QuotaConfig, "maxCount" | "windowSize" | "enabled" | "notes">,
  knownSecrets: string[] = [],
): QuotaPolicySnapshot {
  return {
    maxCount: config.maxCount,
    windowSize: config.windowSize,
    enabled: config.enabled,
    notes: config.notes == null ? null : redactCredentials(config.notes, knownSecrets),
  };
}

export function normalizeReason(reason: unknown, knownSecrets: string[] = []): string {
  if (typeof reason !== "string" || reason.trim() === "") return DEFAULT_ADJUSTMENT_REASON;
  return redactCredentials(reason.trim().slice(0, MAX_REASON_LENGTH), knownSecrets);
}

/** Actor identity is the agent id only — never the credential used. */
export function actorForAgent(talosId: string): string {
  return `agent:${talosId}`;
}
