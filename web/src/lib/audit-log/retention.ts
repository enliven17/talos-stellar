/**
 * Audit retention with checkpoint continuity — pure, I/O-free module.
 *
 * Old audit rows may be pruned only when doing so cannot weaken the evidence
 * that remains. A range is prunable only when it is:
 *
 *   - closed   — it lies entirely inside a signed checkpoint bundle and is
 *                followed by a retained successor (the anchor) that links to
 *                it, so it is never the open chain tail;
 *   - verified — the stored rows recompute to their entryHash, link to each
 *                other contiguously, and match the signed checkpoint entries
 *                hash-for-hash.
 *
 * The last entry before the surviving chain (the "anchor") is never pruned.
 * It is the predecessor evidence that lets every surviving range be verified
 * with `verifyChainRange(rows, { predecessor: anchor })`, and its hash is
 * attested by the signed checkpoint, which operators keep as the proof of
 * what was pruned.
 *
 * Retention is opt-in (`AUDIT_RETENTION_ENABLED`, default off). The store
 * applies a plan with `applyAuditRetention` in `./store`.
 */

import {
  MAX_AUDIT_CHECKPOINT_LIMIT,
  verifyAuditCheckpointBundle,
  verifyChainRange,
  type AuditChainRow,
  type AuditCheckpointBundle,
  type AuditCheckpointEntry,
  type AuditCheckpointVerificationFailureReason,
  type ChainFailureReason,
  type VerifyAuditCheckpointBundleOptions,
} from "@/lib/audit-chain";

// ── Constants & configuration ────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default age after which a closed, verified audit entry may be pruned. */
export const DEFAULT_AUDIT_RETENTION_MS = 365 * DAY_MS;

/** Default number of newest chained entries that are always retained. */
export const DEFAULT_AUDIT_RETENTION_MIN_ENTRIES = 1000;

/** Default maximum number of entries pruned per retention run. */
export const DEFAULT_AUDIT_RETENTION_BATCH_SIZE = 500;

/**
 * Hard ceiling on entries pruned per run. A prune range must be covered by a
 * single checkpoint bundle, so it can never exceed the bundle bound.
 */
export const MAX_AUDIT_RETENTION_BATCH_SIZE = MAX_AUDIT_CHECKPOINT_LIMIT;

export interface AuditRetentionPolicy {
  /** Entries newer than `now - retentionMs` are never pruned. */
  retentionMs: number;
  /** Always retain at least this many newest chained entries (min 1). */
  minRetainedEntries: number;
  /** Maximum entries pruned per run, clamped to `[1, MAX_AUDIT_RETENTION_BATCH_SIZE]`. */
  maxPruneBatch: number;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Whether audit retention pruning is enabled. Defaults to false (opt-in). */
export function isAuditRetentionEnabled(): boolean {
  const val = process.env.AUDIT_RETENTION_ENABLED;
  if (val === undefined || val === "") return false;
  return val.toLowerCase() === "true" || val === "1";
}

/**
 * Resolve the retention policy from the environment. Absent or malformed
 * values fall back to safe defaults rather than failing open.
 */
export function getAuditRetentionPolicy(): AuditRetentionPolicy {
  return normalizeAuditRetentionPolicy({
    retentionMs: envPositiveInt("AUDIT_RETENTION_MS", DEFAULT_AUDIT_RETENTION_MS),
    minRetainedEntries: envPositiveInt(
      "AUDIT_RETENTION_MIN_ENTRIES",
      DEFAULT_AUDIT_RETENTION_MIN_ENTRIES,
    ),
    maxPruneBatch: envPositiveInt("AUDIT_RETENTION_BATCH_SIZE", DEFAULT_AUDIT_RETENTION_BATCH_SIZE),
  })!;
}

/**
 * Normalize a retention policy, filling defaults and clamping the batch size.
 * Returns null for a policy that is out of range.
 */
export function normalizeAuditRetentionPolicy(
  policy: Partial<AuditRetentionPolicy> = {},
): AuditRetentionPolicy | null {
  const retentionMs = policy.retentionMs ?? DEFAULT_AUDIT_RETENTION_MS;
  const minRetainedEntries = policy.minRetainedEntries ?? DEFAULT_AUDIT_RETENTION_MIN_ENTRIES;
  const maxPruneBatch = policy.maxPruneBatch ?? DEFAULT_AUDIT_RETENTION_BATCH_SIZE;
  if (
    !Number.isFinite(retentionMs) ||
    retentionMs <= 0 ||
    !Number.isInteger(minRetainedEntries) ||
    minRetainedEntries < 1 ||
    !Number.isFinite(maxPruneBatch) ||
    maxPruneBatch < 1
  ) {
    return null;
  }
  return {
    retentionMs,
    minRetainedEntries,
    maxPruneBatch: Math.min(Math.floor(maxPruneBatch), MAX_AUDIT_RETENTION_BATCH_SIZE),
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type AuditRetentionRefusalReason =
  | "invalid_policy"
  | "checkpoint_invalid"
  | "checkpoint_empty"
  | "checkpoint_not_covering"
  | "checkpoint_mismatch"
  | "chain_unverified";

export type AuditRetentionNoopReason =
  | "no_entries"
  | "within_retention_window"
  | "min_retained_entries"
  | "range_not_closed";

/** Predecessor evidence retained in place for the surviving chain. */
export interface AuditRetentionAnchor {
  talosId: string;
  sequenceNumber: number;
  entryHash: string;
  previousHash: string;
  createdAt: string;
}

export interface AuditRetentionPlan {
  /**
   * - `prune`:   `[pruneFromSequence, pruneThroughSequence]` is verified and closed.
   * - `noop`:    nothing is eligible yet; nothing may be deleted.
   * - `refused`: evidence failed verification; nothing may be deleted.
   */
  action: "prune" | "noop" | "refused";
  reason: AuditRetentionRefusalReason | AuditRetentionNoopReason | null;
  talosId: string;
  pruneFromSequence: number | null;
  pruneThroughSequence: number | null;
  pruneCount: number;
  /** Predecessor evidence retained for the surviving chain. */
  anchor: AuditRetentionAnchor | null;
  /** Sequence number where evidence diverged, when refused for a mismatch. */
  brokenAtSequence: number | null;
  /** Retention-window cutoff used for this plan (ISO-8601). */
  cutoff: string;
  checkpointChainRoot: string | null;
  checkpointFailureReason: AuditCheckpointVerificationFailureReason | null;
  chainFailureReason: ChainFailureReason | null;
}

export interface PlanAuditRetentionInput {
  talosId: string;
  /**
   * Chained rows ascending by sequence number, starting at the oldest stored
   * chained entry for the agent. Should include the candidate anchor.
   */
  rows: AuditChainRow[];
  /** Highest chained sequence number currently stored for the agent. */
  latestSequence: number | null;
  /** Signed checkpoint bundle that closes the range (verified here). */
  checkpoint: unknown;
  /** Key material for checkpoint verification. A signature is always required. */
  checkpointVerification?: Pick<VerifyAuditCheckpointBundleOptions, "hmacSecret" | "publicKey">;
  policy: Partial<AuditRetentionPolicy>;
  now: Date;
}

type ChainedRow = AuditChainRow & {
  sequenceNumber: number;
  entryHash: string;
  previousHash: string;
  chainVersion: string;
};

function isChained(row: AuditChainRow): row is ChainedRow {
  return row.sequenceNumber !== null && !!row.entryHash && !!row.previousHash && !!row.chainVersion;
}

// ── Planner ──────────────────────────────────────────────────────────────────

/**
 * Decide which audit entries, if any, may be pruned without breaking the
 * verifiability of the surviving chain.
 *
 * The plan prunes `[oldest, anchor - 1]`, where `anchor` is the highest
 * sequence number that satisfies every bound:
 *   - inside the signed checkpoint (`anchor <= checkpoint.endSequence`);
 *   - leaves at least `minRetainedEntries` entries (`anchor <= latest - min + 1`);
 *   - every pruned entry is older than `now - retentionMs`;
 *   - at most `maxPruneBatch` entries are pruned;
 *   - the anchor row is present in `rows`.
 *
 * Any verification failure refuses the whole run; there is no partial pruning.
 */
export function planAuditRetention(input: PlanAuditRetentionInput): AuditRetentionPlan {
  const policy = normalizeAuditRetentionPolicy(input.policy);
  const cutoffMs = input.now.getTime() - (policy?.retentionMs ?? 0);
  const cutoff = new Date(cutoffMs).toISOString();

  const plan = (
    action: AuditRetentionPlan["action"],
    reason: AuditRetentionPlan["reason"],
    extra: Partial<AuditRetentionPlan> = {},
  ): AuditRetentionPlan => ({
    action,
    reason,
    talosId: input.talosId,
    pruneFromSequence: null,
    pruneThroughSequence: null,
    pruneCount: 0,
    anchor: null,
    brokenAtSequence: null,
    cutoff,
    checkpointChainRoot: null,
    checkpointFailureReason: null,
    chainFailureReason: null,
    ...extra,
  });

  if (policy === null) return plan("refused", "invalid_policy");

  // 1. The checkpoint must be a valid, signed bundle for this agent.
  const checkpointResult = verifyAuditCheckpointBundle(input.checkpoint, {
    hmacSecret: input.checkpointVerification?.hmacSecret,
    publicKey: input.checkpointVerification?.publicKey,
    expectedTalosId: input.talosId,
    requireSignature: true,
  });
  if (!checkpointResult.valid || !checkpointResult.signatureValid) {
    return plan("refused", "checkpoint_invalid", {
      checkpointFailureReason: checkpointResult.failureReason,
    });
  }
  const checkpoint = input.checkpoint as AuditCheckpointBundle;
  const checkpointChainRoot = checkpoint.chainRoot;
  const cpStart = checkpoint.boundaries.startSequence;
  const cpEnd = checkpoint.boundaries.endSequence;
  if (cpStart === null || cpEnd === null || checkpoint.entries.length === 0) {
    return plan("refused", "checkpoint_empty", { checkpointChainRoot });
  }

  const rows = input.rows.filter(isChained);
  if (rows.length === 0 || input.latestSequence === null) {
    return plan("noop", "no_entries", { checkpointChainRoot });
  }

  const first = rows[0];
  const firstSeq = first.sequenceNumber;

  // 2. The checkpoint must cover the oldest stored entry, so every entry that
  //    could be pruned is attested by the signature.
  if (cpStart > firstSeq || cpEnd < firstSeq) {
    return plan("refused", "checkpoint_not_covering", { checkpointChainRoot });
  }
  const signedBySeq = new Map<number, AuditCheckpointEntry>();
  for (const entry of checkpoint.entries) signedBySeq.set(entry.sequenceNumber, entry);

  // 3. The stored rows must form a verified contiguous chain. A non-genesis
  //    oldest row is the anchor left by a previous run; its link to the pruned
  //    predecessor is attested by the signed checkpoint entry.
  const firstSigned = signedBySeq.get(firstSeq);
  if (!firstSigned) {
    return plan("refused", "checkpoint_not_covering", { checkpointChainRoot });
  }
  const predecessor =
    firstSeq === 0 ? null : { sequenceNumber: firstSeq - 1, entryHash: firstSigned.previousHash };
  const chain = verifyChainRange(rows, { predecessor });
  if (chain.status !== "valid") {
    return plan("refused", "chain_unverified", {
      checkpointChainRoot,
      brokenAtSequence: chain.brokenAtSequence,
      chainFailureReason: chain.failureReason,
    });
  }

  // 4. Find the highest anchor allowed by every bound.
  const minRetainedBound = input.latestSequence - policy.minRetainedEntries + 1;
  let anchorSeq = Math.min(
    cpEnd,
    minRetainedBound,
    firstSeq + policy.maxPruneBatch,
    rows[rows.length - 1].sequenceNumber,
  );
  for (const row of rows) {
    if (row.sequenceNumber >= anchorSeq) break;
    if (row.createdAt.getTime() > cutoffMs) {
      anchorSeq = row.sequenceNumber;
      break;
    }
  }

  if (anchorSeq <= firstSeq) {
    const reason: AuditRetentionNoopReason =
      first.createdAt.getTime() > cutoffMs
        ? "within_retention_window"
        : minRetainedBound <= firstSeq
          ? "min_retained_entries"
          : "range_not_closed";
    return plan("noop", reason, { checkpointChainRoot });
  }

  // 5. Every pruned row and the anchor must match the signed checkpoint.
  let anchorRow: ChainedRow | null = null;
  for (const row of rows) {
    if (row.sequenceNumber > anchorSeq) break;
    const signed = signedBySeq.get(row.sequenceNumber);
    if (
      !signed ||
      signed.entryHash !== row.entryHash ||
      signed.previousHash !== row.previousHash
    ) {
      return plan("refused", "checkpoint_mismatch", {
        checkpointChainRoot,
        brokenAtSequence: row.sequenceNumber,
      });
    }
    if (row.sequenceNumber === anchorSeq) anchorRow = row;
  }
  if (anchorRow === null) {
    return plan("noop", "range_not_closed", { checkpointChainRoot });
  }

  return plan("prune", null, {
    checkpointChainRoot,
    pruneFromSequence: firstSeq,
    pruneThroughSequence: anchorSeq - 1,
    pruneCount: anchorSeq - firstSeq,
    anchor: {
      talosId: input.talosId,
      sequenceNumber: anchorRow.sequenceNumber,
      entryHash: anchorRow.entryHash,
      previousHash: anchorRow.previousHash,
      createdAt: anchorRow.createdAt.toISOString(),
    },
  });
}
