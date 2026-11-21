import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tamper-evident audit log hash chain.
 *
 * Each audit log entry is cryptographically chained to the previous entry
 * via SHA-256 hashing. Any modification, insertion, or deletion of entries
 * breaks the chain and is detectable.
 *
 * Design:
 *   - Per-agent chain: each TALOS has its own independent chain.
 *   - Canonical encoding: deterministic JSON with fixed property order.
 *   - Domain separator: prevents cross-protocol hash collisions.
 *   - Optional HMAC key for additional authentication of chain roots.
 */

/** Domain separator for the audit log hash chain. */
export const AUDIT_CHAIN_DOMAIN = "talos.audit.v1";

/** Chain schema version for future migration. */
export const AUDIT_CHAIN_VERSION = "1";

/** Sentinel value for the genesis (first) entry's previousHash. */
export const GENESIS_HASH = "GENESIS";

export interface AuditChainEntry {
  sequenceNumber: number;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  createdAt: string;
}

/**
 * Deterministic JSON serialization with fixed property order.
 *
 * This produces the canonical form used for hashing. Every value is
 * stringified according to its type; no pretty-printing or key reordering
 * is allowed after this function runs.
 */
export function canonicalize(entry: AuditChainEntry): string {
  return JSON.stringify({
    sequenceNumber: entry.sequenceNumber,
    talosId: entry.talosId,
    method: entry.method,
    path: entry.path,
    statusCode: entry.statusCode,
    ipAddress: entry.ipAddress,
    createdAt: entry.createdAt,
  });
}

/**
 * Compute the SHA-256 hex digest of a canonical audit chain entry
 * prefixed with the domain separator.
 *
 *   hash = SHA-256(domain:canonical_json)
 */
export function computeEntryHash(entry: AuditChainEntry): string {
  const payload = `${AUDIT_CHAIN_DOMAIN}:${canonicalize(entry)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Compute an HMAC-SHA256 root seal over the chain's latest entry hash.
 *
 * This is used by the verification endpoint to optionally prove that the
 * chain root was signed by the server. It is NOT stored in the database;
 * it is computed on the fly during verification.
 */
export function sealChainRoot(
  entryHash: string,
  hmacSecret: string,
): string {
  return createHmac("sha256", hmacSecret)
    .update(entryHash, "utf8")
    .digest("hex");
}

/**
 * Verify that a seal matches the given entry hash.
 */
export function verifyChainRootSeal(
  entryHash: string,
  hmacSecret: string,
  seal: string,
): boolean {
  const expected = sealChainRoot(entryHash, hmacSecret);
  if (!/^[0-9a-f]{64}$/.test(seal)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(seal, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ChainVerificationStatus = "valid" | "broken" | "incomplete";

export type ChainFailureReason =
  | "out_of_order_records"
  | "missing_predecessor"
  | "predecessor_mismatch"
  | "unexpected_genesis"
  | "sequence_gap"
  | "previous_hash_mismatch"
  | "entry_hash_mismatch"
  | "truncated_range";

export interface AuditChainRow {
  sequenceNumber: number | null;
  entryHash: string | null;
  previousHash: string | null;
  chainVersion: string | null;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  createdAt: Date;
}

export interface AuditChainPredecessor {
  sequenceNumber: number | null;
  entryHash: string | null;
  createdAt?: Date;
}

export interface VerifyChainRangeOptions {
  /**
   * The immediate chained predecessor before the selected time window,
   * or null if no chained entries exist prior to the window (meaning the
   * window starts at genesis). Omit (undefined) if the caller did not check
   * or supply the predecessor when the range begins after sequence 0.
   */
  predecessor?: AuditChainPredecessor | null;
  /** Inclusive lower bound of the selected time window. */
  from?: Date | string | null;
  /** Inclusive upper bound of the selected time window. */
  to?: Date | string | null;
  /**
   * True when the fetched range was truncated by a query limit and more
   * entries exist within the selected time window.
   */
  truncated?: boolean;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  brokenAtSequence: number | null;
  chainVersion: string | null;
}

export interface ChainRangeVerificationResult extends ChainVerificationResult {
  status: ChainVerificationStatus;
  complete: boolean;
  incompleteReason: ChainFailureReason | null;
  failureReason: ChainFailureReason | null;
  startSequence: number | null;
  endSequence: number | null;
  predecessorSequence: number | null;
  predecessorHash: string | null;
}

function toTimestampMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return ms;
}

function isChainedRow(
  row: AuditChainRow,
): row is AuditChainRow & {
  sequenceNumber: number;
  entryHash: string;
  previousHash: string;
  chainVersion: string;
} {
  return (
    row.sequenceNumber !== null &&
    Boolean(row.entryHash) &&
    Boolean(row.previousHash) &&
    Boolean(row.chainVersion)
  );
}

/**
 * Verify a sequence of audit log entries over a selected time range against
 * the hash chain, validating the predecessor boundary and record ordering,
 * and distinguishing an incomplete range from a broken chain.
 *
 * Each chained entry must satisfy:
 *   1. Records are chronologically and sequentially ordered (non-decreasing
 *      createdAt, strictly increasing sequenceNumber) and within [from, to].
 *   2. The first chained entry in the window links cleanly to `predecessor`
 *      (or GENESIS when sequenceNumber === 0 and predecessor is null/absent).
 *      If sequenceNumber > 0 and no predecessor is provided, the range is
 *      reported as `incomplete` (`missing_predecessor`) rather than `broken`,
 *      while the remaining internal chain links are still verified for tampering.
 *   3. Each entry's `previousHash` matches the preceding entry's `entryHash`.
 *   4. Each entry's `entryHash` matches `computeEntryHash(entry)`.
 *   5. `sequenceNumber` advances by +1 with no gaps.
 */
export function verifyChainRange(
  rows: AuditChainRow[],
  options: VerifyChainRangeOptions = {},
): ChainRangeVerificationResult {
  const fromMs =
    options.from !== undefined && options.from !== null
      ? toTimestampMs(options.from)
      : null;
  const toMs =
    options.to !== undefined && options.to !== null
      ? toTimestampMs(options.to)
      : null;

  if (
    (fromMs !== null && Number.isNaN(fromMs)) ||
    (toMs !== null && Number.isNaN(toMs)) ||
    (fromMs !== null && toMs !== null && fromMs > toMs)
  ) {
    return {
      valid: false,
      status: "incomplete",
      complete: false,
      incompleteReason: "out_of_order_records",
      failureReason: "out_of_order_records",
      totalEntries: rows.length,
      verifiedEntries: 0,
      brokenAtSequence: null,
      chainVersion: null,
      startSequence: null,
      endSequence: null,
      predecessorSequence: options.predecessor?.sequenceNumber ?? null,
      predecessorHash: options.predecessor?.entryHash ?? null,
    };
  }

  const predecessor = options.predecessor;
  const predecessorSequence = predecessor?.sequenceNumber ?? null;
  const predecessorHash = predecessor?.entryHash ?? null;

  if (rows.length === 0) {
    if (options.truncated) {
      return {
        valid: false,
        status: "incomplete",
        complete: false,
        incompleteReason: "truncated_range",
        failureReason: "truncated_range",
        totalEntries: 0,
        verifiedEntries: 0,
        brokenAtSequence: null,
        chainVersion: null,
        startSequence: null,
        endSequence: null,
        predecessorSequence,
        predecessorHash,
      };
    }

    return {
      valid: true,
      status: "valid",
      complete: true,
      incompleteReason: null,
      failureReason: null,
      totalEntries: 0,
      verifiedEntries: 0,
      brokenAtSequence: null,
      chainVersion: null,
      startSequence: null,
      endSequence: null,
      predecessorSequence,
      predecessorHash,
    };
  }

  let previousEntryHash: string | null = null;
  let expectedSequence: number | null = null;
  let lastTimestampMs: number | null = null;
  let verifiedCount = 0;
  let startSequence: number | null = null;
  let endSequence: number | null = null;
  let lastChainVersion: string | null = null;
  let missingPredecessor = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Skip legacy rows that predate the hash chain
    if (!isChainedRow(row)) {
      continue;
    }

    const rowMs = row.createdAt.getTime();
    if (
      Number.isNaN(rowMs) ||
      (fromMs !== null && rowMs < fromMs) ||
      (toMs !== null && rowMs > toMs) ||
      (lastTimestampMs !== null && rowMs < lastTimestampMs)
    ) {
      return {
        valid: false,
        status: "broken",
        complete: false,
        incompleteReason: null,
        failureReason: "out_of_order_records",
        totalEntries: rows.length,
        verifiedEntries: verifiedCount,
        brokenAtSequence: row.sequenceNumber,
        chainVersion: row.chainVersion,
        startSequence,
        endSequence,
        predecessorSequence,
        predecessorHash,
      };
    }

    if (startSequence === null) {
      startSequence = row.sequenceNumber;

      // Validate predecessor boundary on the first chained record in the range
      if (predecessor !== undefined && predecessor !== null) {
        if (
          predecessor.sequenceNumber === null ||
          !predecessor.entryHash ||
          (predecessor.createdAt &&
            predecessor.createdAt.getTime() > rowMs) ||
          (fromMs !== null &&
            predecessor.createdAt &&
            predecessor.createdAt.getTime() >= fromMs)
        ) {
          return {
            valid: false,
            status: "broken",
            complete: false,
            incompleteReason: null,
            failureReason: "predecessor_mismatch",
            totalEntries: rows.length,
            verifiedEntries: 0,
            brokenAtSequence: row.sequenceNumber,
            chainVersion: row.chainVersion,
            startSequence,
            endSequence,
            predecessorSequence,
            predecessorHash,
          };
        }

        if (row.sequenceNumber === 0 || row.previousHash === GENESIS_HASH) {
          return {
            valid: false,
            status: "broken",
            complete: false,
            incompleteReason: null,
            failureReason: "unexpected_genesis",
            totalEntries: rows.length,
            verifiedEntries: 0,
            brokenAtSequence: row.sequenceNumber,
            chainVersion: row.chainVersion,
            startSequence,
            endSequence,
            predecessorSequence,
            predecessorHash,
          };
        }

        if (
          row.sequenceNumber !== predecessor.sequenceNumber + 1 ||
          row.previousHash !== predecessor.entryHash
        ) {
          return {
            valid: false,
            status: "broken",
            complete: false,
            incompleteReason: null,
            failureReason: "predecessor_mismatch",
            totalEntries: rows.length,
            verifiedEntries: 0,
            brokenAtSequence: row.sequenceNumber,
            chainVersion: row.chainVersion,
            startSequence,
            endSequence,
            predecessorSequence,
            predecessorHash,
          };
        }

        expectedSequence = row.sequenceNumber;
        previousEntryHash = predecessor.entryHash;
      } else if (predecessor === null) {
        // Caller explicitly established there is no prior entry before the window:
        // the first chained record MUST be genesis (sequenceNumber 0, previousHash GENESIS).
        if (row.sequenceNumber !== 0) {
          return {
            valid: false,
            status: "incomplete",
            complete: false,
            incompleteReason: "missing_predecessor",
            failureReason: "missing_predecessor",
            totalEntries: rows.length,
            verifiedEntries: 0,
            brokenAtSequence: null,
            chainVersion: row.chainVersion,
            startSequence,
            endSequence: row.sequenceNumber,
            predecessorSequence,
            predecessorHash,
          };
        }
        if (row.previousHash !== GENESIS_HASH) {
          return {
            valid: false,
            status: "broken",
            complete: false,
            incompleteReason: null,
            failureReason: "previous_hash_mismatch",
            totalEntries: rows.length,
            verifiedEntries: 0,
            brokenAtSequence: row.sequenceNumber,
            chainVersion: row.chainVersion,
            startSequence,
            endSequence,
            predecessorSequence,
            predecessorHash,
          };
        }
        expectedSequence = 0;
        previousEntryHash = null;
      } else {
        // predecessor === undefined: caller did not provide predecessor context
        if (row.sequenceNumber === 0) {
          if (row.previousHash !== GENESIS_HASH) {
            return {
              valid: false,
              status: "broken",
              complete: false,
              incompleteReason: null,
              failureReason: "previous_hash_mismatch",
              totalEntries: rows.length,
              verifiedEntries: 0,
              brokenAtSequence: row.sequenceNumber,
              chainVersion: row.chainVersion,
              startSequence,
              endSequence,
              predecessorSequence,
              predecessorHash,
            };
          }
          expectedSequence = 0;
          previousEntryHash = null;
        } else {
          // Range starts at sequenceNumber > 0 without predecessor boundary context.
          // If it claims GENESIS at sequenceNumber > 0, that's a broken chain.
          if (row.previousHash === GENESIS_HASH) {
            return {
              valid: false,
              status: "broken",
              complete: false,
              incompleteReason: null,
              failureReason: "unexpected_genesis",
              totalEntries: rows.length,
              verifiedEntries: 0,
              brokenAtSequence: row.sequenceNumber,
              chainVersion: row.chainVersion,
              startSequence,
              endSequence,
              predecessorSequence,
              predecessorHash,
            };
          }
          missingPredecessor = true;
          expectedSequence = row.sequenceNumber;
          previousEntryHash = row.previousHash;
        }
      }
    } else {
      // Subsequent chained entry in the window
      if (expectedSequence !== null && row.sequenceNumber < expectedSequence) {
        return {
          valid: false,
          status: "broken",
          complete: false,
          incompleteReason: null,
          failureReason: "out_of_order_records",
          totalEntries: rows.length,
          verifiedEntries: verifiedCount,
          brokenAtSequence: row.sequenceNumber,
          chainVersion: row.chainVersion,
          startSequence,
          endSequence,
          predecessorSequence,
          predecessorHash,
        };
      }

      if (expectedSequence !== null && row.sequenceNumber !== expectedSequence) {
        return {
          valid: false,
          status: "broken",
          complete: false,
          incompleteReason: null,
          failureReason: "sequence_gap",
          totalEntries: rows.length,
          verifiedEntries: verifiedCount,
          brokenAtSequence: row.sequenceNumber,
          chainVersion: row.chainVersion,
          startSequence,
          endSequence,
          predecessorSequence,
          predecessorHash,
        };
      }

      const expectedPreviousHash = previousEntryHash ?? GENESIS_HASH;
      if (row.previousHash !== expectedPreviousHash) {
        return {
          valid: false,
          status: "broken",
          complete: false,
          incompleteReason: null,
          failureReason: "previous_hash_mismatch",
          totalEntries: rows.length,
          verifiedEntries: verifiedCount,
          brokenAtSequence: row.sequenceNumber,
          chainVersion: row.chainVersion,
          startSequence,
          endSequence,
          predecessorSequence,
          predecessorHash,
        };
      }
    }

    // Validate entryHash integrity
    const entry: AuditChainEntry = {
      sequenceNumber: row.sequenceNumber,
      talosId: row.talosId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    };

    const recomputed = computeEntryHash(entry);
    if (recomputed !== row.entryHash) {
      return {
        valid: false,
        status: "broken",
        complete: false,
        incompleteReason: null,
        failureReason: "entry_hash_mismatch",
        totalEntries: rows.length,
        verifiedEntries: verifiedCount,
        brokenAtSequence: row.sequenceNumber,
        chainVersion: row.chainVersion,
        startSequence,
        endSequence,
        predecessorSequence,
        predecessorHash,
      };
    }

    previousEntryHash = row.entryHash;
    expectedSequence = row.sequenceNumber + 1;
    lastTimestampMs = rowMs;
    endSequence = row.sequenceNumber;
    lastChainVersion = row.chainVersion;
    verifiedCount++;
  }

  if (missingPredecessor) {
    return {
      valid: false,
      status: "incomplete",
      complete: false,
      incompleteReason: "missing_predecessor",
      failureReason: "missing_predecessor",
      totalEntries: rows.length,
      verifiedEntries: verifiedCount,
      brokenAtSequence: null,
      chainVersion: lastChainVersion,
      startSequence,
      endSequence,
      predecessorSequence,
      predecessorHash,
    };
  }

  if (options.truncated) {
    return {
      valid: false,
      status: "incomplete",
      complete: false,
      incompleteReason: "truncated_range",
      failureReason: "truncated_range",
      totalEntries: rows.length,
      verifiedEntries: verifiedCount,
      brokenAtSequence: null,
      chainVersion: lastChainVersion,
      startSequence,
      endSequence,
      predecessorSequence,
      predecessorHash,
    };
  }

  return {
    valid: true,
    status: "valid",
    complete: true,
    incompleteReason: null,
    failureReason: null,
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    brokenAtSequence: null,
    chainVersion: lastChainVersion ?? rows[rows.length - 1].chainVersion,
    startSequence,
    endSequence,
    predecessorSequence,
    predecessorHash,
  };
}

/**
 * Verify a sequence of audit log entries against the hash chain from genesis.
 *
 * Each entry must satisfy:
 *   1. entryHash === computeEntryHash(entry)
 *   2. previousHash === entryHash of the preceding entry (or GENESIS for seq 0)
 *   3. sequenceNumber is sequential (0, 1, 2, ...)
 */
export function verifyChain(rows: AuditChainRow[]): ChainVerificationResult {
  if (rows.length === 0) {
    return {
      valid: true,
      totalEntries: 0,
      verifiedEntries: 0,
      brokenAtSequence: null,
      chainVersion: null,
    };
  }

  let previousEntryHash: string | null = null;
  let chainIndex = 0;
  let verifiedCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Skip legacy rows that predate the hash chain
    if (row.sequenceNumber === null || !row.entryHash || !row.previousHash || !row.chainVersion) {
      continue;
    }

    // Validate sequence number is sequential within the chain
    if (row.sequenceNumber !== chainIndex) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: verifiedCount,
        brokenAtSequence: row.sequenceNumber,
        chainVersion: row.chainVersion,
      };
    }

    // Validate previousHash linkage
    const expectedPreviousHash = previousEntryHash ?? GENESIS_HASH;
    if (row.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: verifiedCount,
        brokenAtSequence: row.sequenceNumber,
        chainVersion: row.chainVersion,
      };
    }

    // Validate entryHash integrity
    const entry: AuditChainEntry = {
      sequenceNumber: row.sequenceNumber,
      talosId: row.talosId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    };

    const recomputed = computeEntryHash(entry);
    if (recomputed !== row.entryHash) {
      return {
        valid: false,
        totalEntries: rows.length,
        verifiedEntries: verifiedCount,
        brokenAtSequence: row.sequenceNumber,
        chainVersion: row.chainVersion,
      };
    }

    previousEntryHash = row.entryHash;
    chainIndex++;
    verifiedCount++;
  }

  return {
    valid: true,
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    brokenAtSequence: null,
    chainVersion: rows[rows.length - 1].chainVersion,
  };
}

/**
 * Whether hash chain is enabled for the audit log.
 * Defaults to true (backward-compatible rollout).
 */
export function isAuditChainEnabled(): boolean {
  const val = process.env.AUDIT_HASH_CHAIN_ENABLED;
  if (val === undefined || val === "") return true;
  return val.toLowerCase() !== "false" && val !== "0";
}

/**
 * Get the optional HMAC secret for chain root sealing.
 * Returns null if not configured.
 */
export function getChainHmacSecret(): string | null {
  return process.env.AUDIT_HASH_CHAIN_SECRET ?? null;
}
