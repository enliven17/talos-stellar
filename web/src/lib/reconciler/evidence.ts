/**
 * Payment finality decision evidence trail.
 *
 * Captures an immutable record of each finality transition decision:
 *   - Closed ledger sequence number where observed/decided
 *   - Observation source (horizon, wall_clock, ledger_gap, reconciler)
 *   - Transition reason explaining why the state changed
 *   - From and To states
 *   - Timestamp of decision
 *   - Non-sensitive metadata (e.g. pollCount, depth, error detail)
 *
 * Invariants:
 *   - NO secrets, secret keys, seeds, or user payload data are ever stored.
 *   - Bounded capacity ring buffer prevents unbounded memory growth.
 *   - Bounded read queries prevent payload or metric explosion.
 */

import type { FinalityStatus, FinalityEvidence } from "./types";

export interface FinalityEvidenceFilter {
  txHash?: string;
  status?: FinalityStatus | string;
  source?: string;
  limit?: number;
}

export const DEFAULT_MAX_EVIDENCE_ENTRIES = 500;
export const MAX_READ_LIMIT = 200;
export const DEFAULT_READ_LIMIT = 50;

/** Truncate a Stellar transaction hash to a privacy-safe display string (e.g. "abcd1234...ef567890"). */
export function truncateTxHash(hash: string | null | undefined): string {
  if (!hash) return "";
  const trimmed = hash.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-8)}`;
}

// Keys that must NEVER appear in metadata
const FORBIDDEN_METADATA_KEYS = new Set([
  "secret",
  "secretkey",
  "privatekey",
  "seed",
  "password",
  "token",
  "key",
  "envelopexdr",
  "resultxdr",
  "xdr",
  "payload",
]);

export function sanitizeEvidenceMetadata(
  meta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(meta)) {
    const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      FORBIDDEN_METADATA_KEYS.has(lowerKey) ||
      lowerKey.includes("secret") ||
      lowerKey.includes("private") ||
      lowerKey.includes("seed") ||
      lowerKey.includes("password") ||
      lowerKey.includes("xdr") ||
      lowerKey.includes("payload")
    ) {
      continue;
    }
    // Also guard string values that look like Stellar secret keys (S... 56 chars)
    if (typeof val === "string" && /^S[0-9A-Z]{55}$/.test(val)) continue;
    sanitized[key] = val;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

// GlobalThis singleton for hot reload safety and shared process memory
const g = globalThis as typeof globalThis & {
  __reconcilerEvidence?: FinalityEvidence[];
};

function getEvidenceBuffer(): FinalityEvidence[] {
  if (!g.__reconcilerEvidence) {
    g.__reconcilerEvidence = [];
  }
  return g.__reconcilerEvidence;
}

/**
 * Record a payment finality decision in the bounded in-memory trail.
 */
export function recordEvidence(
  entry: FinalityEvidence,
  maxEntries: number = DEFAULT_MAX_EVIDENCE_ENTRIES,
): FinalityEvidence {
  const buffer = getEvidenceBuffer();
  const decidedAt =
    entry.decidedAt instanceof Date ? entry.decidedAt : new Date(entry.decidedAt ?? Date.now());

  const sanitized: FinalityEvidence = {
    txHash: entry.txHash,
    txHashTruncated: truncateTxHash(entry.txHash),
    ledger: typeof entry.ledger === "number" && !Number.isNaN(entry.ledger) ? entry.ledger : null,
    observationSource: entry.observationSource || "reconciler",
    transitionReason: entry.transitionReason,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    decidedAt,
    metadata: sanitizeEvidenceMetadata(entry.metadata),
  };

  buffer.push(sanitized);

  // Enforce bounded ring-buffer capacity (FIFO eviction)
  const cap = Math.max(1, maxEntries);
  if (buffer.length > cap) {
    buffer.splice(0, buffer.length - cap);
  }

  return sanitized;
}

/**
 * Retrieve evidence trail entries with optional filtering and bounded pagination.
 * Always returns entries ordered latest-first.
 */
export function getEvidenceTrail(
  filter?: FinalityEvidenceFilter,
  maxLimit: number = MAX_READ_LIMIT,
): FinalityEvidence[] {
  const buffer = getEvidenceBuffer();
  let results = [...buffer];

  if (filter?.txHash) {
    const target = filter.txHash.trim().toLowerCase();
    results = results.filter((e) => e.txHash?.toLowerCase() === target);
  }

  if (filter?.status) {
    const target = filter.status.trim().toUpperCase();
    results = results.filter(
      (e) => e.toStatus === target || e.fromStatus === target,
    );
  }

  if (filter?.source) {
    const target = filter.source.trim().toLowerCase();
    results = results.filter(
      (e) => e.observationSource.toLowerCase() === target,
    );
  }

  // Reverse so newest entries come first
  results.reverse();

  const requestedLimit = filter?.limit ?? DEFAULT_READ_LIMIT;
  const boundedLimit = Math.max(1, Math.min(requestedLimit, maxLimit));

  return results.slice(0, boundedLimit);
}

/**
 * Clear the in-memory evidence trail (primarily for isolated test fixtures).
 */
export function clearEvidenceTrail(): void {
  g.__reconcilerEvidence = [];
}

/**
 * Get current count of evidence entries in memory.
 */
export function getEvidenceCount(): number {
  return getEvidenceBuffer().length;
}
