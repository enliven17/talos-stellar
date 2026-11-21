/**
 * Audit integrity readiness check — pure, I/O-free module.
 *
 * Consumers supply the result of a bounded chain verification pass and the
 * timestamp of the most recent checkpoint; this module classifies the result
 * into four distinct statuses so the caller can surface chain breaks and
 * stale checkpoints separately rather than collapsing them into a single
 * boolean.
 *
 * Keeping this logic pure lets it be tested without a database and reused by
 * the health endpoint, the admin audit UI, and any future worker that monitors
 * chain freshness.
 */

import type { ChainVerificationResult } from "@/lib/audit-chain";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of entries sampled per integrity check.
 *
 * A bounded window prevents a full-history scan on every request while still
 * catching recent tampering. 100 entries covers roughly one to two hours of
 * traffic at typical API volumes.
 */
export const AUDIT_INTEGRITY_SAMPLE_SIZE = 100;

/**
 * A checkpoint is considered stale when it is older than this threshold.
 * Default: 1 hour.
 */
export const AUDIT_CHECKPOINT_STALE_MS = 60 * 60 * 1_000;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Four-way status to report stale checkpoints and chain breaks separately.
 *
 * - `ok`                — chain intact, checkpoint fresh
 * - `chain_broken`      — hash chain has a detectable break, checkpoint fresh
 * - `checkpoint_stale`  — chain intact but no recent checkpoint
 * - `degraded`          — both conditions are present
 */
export type AuditIntegrityStatus =
  | "ok"
  | "chain_broken"
  | "checkpoint_stale"
  | "degraded";

export interface AuditIntegrityReport {
  /** Whether the sampled entries form a valid hash chain. */
  chainValid: boolean;
  /** Whether the most recent checkpoint falls within the freshness window. */
  checkpointFresh: boolean;
  /** Number of entries included in this check (bounded by AUDIT_INTEGRITY_SAMPLE_SIZE). */
  sampledEntries: number;
  /** Sequence number at which the chain breaks, or null when the chain is intact. */
  brokenAtSequence: number | null;
  /** ISO timestamp of the last successfully verified entry, or null when none exist. */
  lastVerifiedAt: string | null;
  /** ISO timestamp of the most recent checkpoint, or null when no checkpoint has been created. */
  lastCheckpointAt: string | null;
  /** Age of the checkpoint in milliseconds, or null when no checkpoint exists. */
  checkpointAgeMs: number | null;
  /** True when the checkpoint is absent or older than AUDIT_CHECKPOINT_STALE_MS. */
  checkpointStale: boolean;
  /** Composite health status. */
  status: AuditIntegrityStatus;
}

// ── Builder ──────────────────────────────────────────────────────────────────

export interface BuildAuditIntegrityReportParams {
  /** Result from verifyChain() on the sampled window. */
  chainResult: ChainVerificationResult;
  /** Number of entries that were passed to verifyChain(). */
  sampledEntries: number;
  /** ISO timestamp of the last entry that was successfully verified, or null. */
  lastVerifiedAt: string | null;
  /** ISO timestamp of the most recent audit checkpoint, or null. */
  lastCheckpointAt: string | null;
  /** Current wall-clock time (injected for testability). */
  now: Date;
}

/**
 * Build an {@link AuditIntegrityReport} from pre-fetched verification results.
 *
 * Status rules
 * ────────────
 * 1. Chain broken  = chainResult.valid is false
 * 2. Stale         = no checkpoint, or checkpoint older than AUDIT_CHECKPOINT_STALE_MS
 * 3. Status matrix:
 *      valid + fresh    → "ok"
 *      broken + fresh   → "chain_broken"
 *      valid + stale    → "checkpoint_stale"
 *      broken + stale   → "degraded"
 */
export function buildAuditIntegrityReport(
  params: BuildAuditIntegrityReportParams,
): AuditIntegrityReport {
  const { chainResult, sampledEntries, lastVerifiedAt, lastCheckpointAt, now } = params;

  const chainValid = chainResult.valid;

  const checkpointAgeMs =
    lastCheckpointAt !== null
      ? now.getTime() - new Date(lastCheckpointAt).getTime()
      : null;

  const checkpointStale =
    checkpointAgeMs === null || checkpointAgeMs > AUDIT_CHECKPOINT_STALE_MS;

  const checkpointFresh = !checkpointStale;

  let status: AuditIntegrityStatus;
  if (chainValid && checkpointFresh) {
    status = "ok";
  } else if (!chainValid && checkpointFresh) {
    status = "chain_broken";
  } else if (chainValid && !checkpointFresh) {
    status = "checkpoint_stale";
  } else {
    status = "degraded";
  }

  return {
    chainValid,
    checkpointFresh,
    sampledEntries,
    brokenAtSequence: chainResult.brokenAtSequence,
    lastVerifiedAt,
    lastCheckpointAt,
    checkpointAgeMs,
    checkpointStale,
    status,
  };
}
