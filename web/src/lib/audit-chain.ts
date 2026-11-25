import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

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
 * Validate that all numeric fields in the canonical audit payload are finite.
 * Rejects NaN, Infinity, and -Infinity before JSON serialization, which would
 * otherwise silently coerce nonfinite numbers to null.
 */
function assertFiniteAuditNumbers(entry: AuditChainEntry): void {
  if (typeof entry.sequenceNumber !== "number" || !Number.isFinite(entry.sequenceNumber)) {
    throw new RangeError(
      `Audit entry canonical payload contains nonfinite sequenceNumber: ${String(entry.sequenceNumber)}`,
    );
  }
  if (typeof entry.statusCode !== "number" || !Number.isFinite(entry.statusCode)) {
    throw new RangeError(
      `Audit entry canonical payload contains nonfinite statusCode: ${String(entry.statusCode)}`,
    );
  }
}

/**
 * Deterministic JSON serialization with fixed property order.
 *
 * This produces the canonical form used for hashing. Every value is
 * stringified according to its type; no pretty-printing or key reordering
 * is allowed after this function runs.
 *
 * @throws {RangeError} If any numeric field in the canonical payload is nonfinite
 *   (`NaN`, `Infinity`, or `-Infinity`).
 */
export function canonicalize(entry: AuditChainEntry): string {
  assertFiniteAuditNumbers(entry);

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
 *
 * @throws {RangeError} If the entry's canonical payload contains nonfinite numbers.
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
  createdAt?: Date | string;
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
  /** True only when the chain is complete and every link verifies. */
  valid: boolean;
  /**
   * Distinct outcome classification:
   *   - "valid":      all chained rows verified, no gaps.
   *   - "incomplete": a predecessor is missing (gap in sequence numbers or
   *                   the chain starts after GENESIS). Evidence is missing,
   *                   not proven tampered.
   *   - "mismatch":   contradictory evidence (hash/linkage does not match
   *                   recomputed values). Indicates tampering.
   */
  status: "valid" | "incomplete" | "mismatch";
  totalEntries: number;
  verifiedEntries: number;
  brokenAtSequence: number | null;
  /** Sequence number expected at the point a gap was detected. */
  missingFromSequence: number | null;
  chainVersion: string | null;
}

export type ChainRow = {
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
};

/**
 * Verify a sequence of audit log entries against the hash chain from genesis.
 *
 * Each entry must satisfy:
 *   1. entryHash === computeEntryHash(entry)
 *   2. previousHash === entryHash of the preceding entry (or GENESIS for seq 0)
 *   3. sequenceNumber is sequential (0, 1, 2, ...)
 *
 * A missing predecessor (sequence gap, or chain not starting at 0) is reported
 * as "incomplete" so operators can distinguish missing evidence from
 * contradictory hashes, which are reported as "mismatch".
 */
export function verifyChain(rows: ChainRow[]): ChainVerificationResult {
  if (rows.length === 0) {
    return {
      valid: true,
      status: "valid",
      totalEntries: 0,
      verifiedEntries: 0,
      brokenAtSequence: null,
      missingFromSequence: null,
      chainVersion: null,
    };
  }

  let previousEntryHash: string | null = null;
  let chainIndex = 0;
  let verifiedCount = 0;

  const mismatch = (seq: number, version: string | null): ChainVerificationResult => ({
    valid: false,
    status: "mismatch",
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    brokenAtSequence: seq,
    missingFromSequence: null,
    chainVersion: version,
  });

  const incomplete = (
    missingFrom: number,
    seq: number | null,
    version: string | null,
  ): ChainVerificationResult => ({
    valid: false,
    status: "incomplete",
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    brokenAtSequence: seq,
    missingFromSequence: missingFrom,
    chainVersion: version,
  });

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Skip legacy rows that predate the hash chain
    if (row.sequenceNumber === null || !row.entryHash || !row.previousHash || !row.chainVersion) {
      continue;
    }

    // A sequence number ahead of the expected one means predecessor(s) are
    // absent: incomplete evidence, not a contradiction. Reported as a gap at
    // the first missing sequence number, never as tampering.
    if (row.sequenceNumber > chainIndex) {
      return incomplete(chainIndex, row.sequenceNumber, row.chainVersion);
    }

    // A sequence number behind the expected one is a duplicate/out-of-order
    // row, which contradicts the chain.
    if (row.sequenceNumber < chainIndex) {
      return mismatch(row.sequenceNumber, row.chainVersion);
    }

    // Validate previousHash linkage
    const expectedPreviousHash = previousEntryHash ?? GENESIS_HASH;
    if (row.previousHash !== expectedPreviousHash) {
      return mismatch(row.sequenceNumber, row.chainVersion);
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
      return mismatch(row.sequenceNumber, row.chainVersion);
    }

    previousEntryHash = row.entryHash;
    chainIndex++;
    verifiedCount++;
  }

  return {
    valid: true,
    status: "valid",
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    brokenAtSequence: null,
    missingFromSequence: null,
    chainVersion: rows[rows.length - 1].chainVersion,
  };
}

export interface ChainRangeVerificationResult {
  /** True only when the range is complete and every link verifies. */
  valid: boolean;
  /**
   *   - "valid":      the range is complete and every link verifies.
   *   - "incomplete": evidence is missing (no predecessor for a non-genesis
   *                   range, or the range was truncated by a query limit).
   *   - "broken":     contradictory evidence (hash/linkage/order mismatch).
   */
  status: ChainVerificationStatus;
  /** True when the range is fully evidenced end to end (status "valid"). */
  complete: boolean;
  /** Why the range is incomplete, or null when it is not. */
  incompleteReason: "missing_predecessor" | "truncated_range" | null;
  /** Classification of the first failure, or null when valid. */
  failureReason: ChainFailureReason | null;
  totalEntries: number;
  verifiedEntries: number;
  /** Sequence number where contradictory evidence was found, or null. */
  brokenAtSequence: number | null;
  chainVersion: string | null;
  startSequence: number | null;
  endSequence: number | null;
  predecessorSequence: number | null;
  predecessorHash: string | null;
}

function toOptionalTime(value: Date | string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Verify a bounded slice of an agent's audit chain (e.g. a selected time
 * window) against its immediate predecessor.
 *
 * Unlike {@link verifyChain}, the slice does not need to start at genesis:
 * the first row is linked to `options.predecessor`. Missing evidence (an
 * omitted or absent predecessor for a non-genesis slice, or a slice truncated
 * by a query limit) is reported as `"incomplete"`; contradictory evidence
 * (hash, linkage, sequence, ordering or window violations) is reported as
 * `"broken"` with the offending sequence number. Internal links are always
 * verified, even when the predecessor is missing.
 */
export function verifyChainRange(
  rows: AuditChainRow[],
  options: VerifyChainRangeOptions = {},
): ChainRangeVerificationResult {
  const chained = rows.filter(
    (row) =>
      row.sequenceNumber !== null &&
      !!row.entryHash &&
      !!row.previousHash &&
      !!row.chainVersion,
  ) as Array<AuditChainRow & { sequenceNumber: number; entryHash: string; previousHash: string; chainVersion: string }>;

  const predecessor = options.predecessor;
  const hasPredecessor =
    predecessor !== undefined &&
    predecessor !== null &&
    predecessor.sequenceNumber !== null &&
    !!predecessor.entryHash;
  const fromMs = toOptionalTime(options.from);
  const toMs = toOptionalTime(options.to);

  const first = chained[0] ?? null;
  const last = chained[chained.length - 1] ?? null;
  let verifiedCount = 0;

  const base = () => ({
    totalEntries: rows.length,
    verifiedEntries: verifiedCount,
    chainVersion: last?.chainVersion ?? null,
    startSequence: first?.sequenceNumber ?? null,
    endSequence: last?.sequenceNumber ?? null,
    predecessorSequence: hasPredecessor ? (predecessor!.sequenceNumber as number) : null,
    predecessorHash: hasPredecessor ? (predecessor!.entryHash as string) : null,
  });

  const broken = (reason: ChainFailureReason, seq: number): ChainRangeVerificationResult => ({
    valid: false,
    status: "broken",
    complete: false,
    incompleteReason: null,
    failureReason: reason,
    brokenAtSequence: seq,
    ...base(),
  });

  let missingPredecessor = false;
  let prev: (typeof chained)[number] | null = null;

  for (const row of chained) {
    const seq = row.sequenceNumber;
    const createdMs = row.createdAt.getTime();

    // Rows outside the selected window, or out of chronological / sequence
    // order, contradict the requested range.
    if ((fromMs !== null && createdMs < fromMs) || (toMs !== null && createdMs > toMs)) {
      return broken("out_of_order_records", seq);
    }
    if (prev !== null && (createdMs < prev.createdAt.getTime() || seq < prev.sequenceNumber)) {
      return broken("out_of_order_records", seq);
    }

    if (prev === null) {
      // First row: link to the predecessor boundary.
      if (row.previousHash === GENESIS_HASH && (seq !== 0 || hasPredecessor)) {
        return broken("unexpected_genesis", seq);
      }
      if (hasPredecessor) {
        if (
          seq !== (predecessor!.sequenceNumber as number) + 1 ||
          row.previousHash !== predecessor!.entryHash
        ) {
          return broken("predecessor_mismatch", seq);
        }
      } else if (seq === 0) {
        if (row.previousHash !== GENESIS_HASH) {
          return broken("previous_hash_mismatch", seq);
        }
      } else {
        // Non-genesis slice without a known predecessor: evidence is missing,
        // not contradictory. Keep verifying internal links.
        missingPredecessor = true;
      }
    } else {
      if (seq !== prev.sequenceNumber + 1) {
        return broken("sequence_gap", seq);
      }
      if (row.previousHash === GENESIS_HASH) {
        return broken("unexpected_genesis", seq);
      }
      if (row.previousHash !== prev.entryHash) {
        return broken("previous_hash_mismatch", seq);
      }
    }

    const recomputed = computeEntryHash({
      sequenceNumber: seq,
      talosId: row.talosId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    });
    if (recomputed !== row.entryHash) {
      return broken("entry_hash_mismatch", seq);
    }

    prev = row;
    verifiedCount++;
  }

  const incompleteReason = missingPredecessor
    ? ("missing_predecessor" as const)
    : options.truncated
      ? ("truncated_range" as const)
      : null;

  if (incompleteReason !== null) {
    return {
      valid: false,
      status: "incomplete",
      complete: false,
      incompleteReason,
      failureReason: incompleteReason,
      brokenAtSequence: null,
      ...base(),
    };
  }

  return {
    valid: true,
    status: "valid",
    complete: true,
    incompleteReason: null,
    failureReason: null,
    brokenAtSequence: null,
    ...base(),
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

// ─── Audit Export Filenames ──────────────────────────────────────────────────

/** Supported operator export formats for the admin audit log. */
export const AUDIT_EXPORT_FORMATS = ["json", "csv"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** Maximum length of an identifier segment embedded in an export filename. */
export const MAX_AUDIT_FILENAME_SEGMENT_LENGTH = 64;

/** Maximum total length of a generated export filename. */
export const MAX_AUDIT_EXPORT_FILENAME_LENGTH = 128;

const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Normalize an identifier for use in an export filename. Only bounded ASCII
 * `[A-Za-z0-9_-]` identifiers (not starting with `-`/`_`) are accepted and
 * lowercased; anything else (Unicode, quotes, separators, CR/LF, path
 * traversal, oversized input) returns null so untrusted actor text never
 * reaches a `Content-Disposition` header.
 */
export function sanitizeAuditExportIdentifier(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_AUDIT_FILENAME_SEGMENT_LENGTH) return null;
  if (!SAFE_IDENTIFIER_RE.test(value)) return null;
  return value.toLowerCase();
}

function formatFilenameTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * Build a bounded, header-safe export filename:
 * `audit-logs-<id|all|filtered>[-YYYYMMDDTHHMMSSZ].<format>`.
 *
 * A missing identifier yields `all`; an unsafe one yields `filtered` (or
 * throws in `strict` mode). An invalid timestamp is omitted (or throws in
 * `strict` mode).
 */
export function buildAuditExportFilename(options: {
  talosId?: string | null;
  format?: AuditExportFormat;
  exportedAt?: Date | string | null;
  strict?: boolean;
}): string {
  const format = options.format ?? "json";
  const rawId = options.talosId;

  let segment = "all";
  if (rawId !== undefined && rawId !== null && rawId !== "") {
    const safe = sanitizeAuditExportIdentifier(rawId);
    if (safe === null) {
      if (options.strict) throw new Error("Invalid audit export identifier");
      segment = "filtered";
    } else {
      segment = safe;
    }
  }

  let timestamp = "";
  if (options.exportedAt !== undefined && options.exportedAt !== null) {
    const d = options.exportedAt instanceof Date ? options.exportedAt : new Date(options.exportedAt);
    if (Number.isNaN(d.getTime())) {
      if (options.strict) throw new Error("Invalid audit export timestamp");
    } else {
      timestamp = `-${formatFilenameTimestamp(d)}`;
    }
  }

  return `audit-logs-${segment}${timestamp}.${format}`.slice(0, MAX_AUDIT_EXPORT_FILENAME_LENGTH);
}

// ─── Independently Verifiable Audit Checkpoint Bundles ───────────────────────

/** Domain separator for signed audit checkpoint bundles. */
export const AUDIT_CHECKPOINT_DOMAIN = "talos.audit.checkpoint.v1";

/** Schema version for signed audit checkpoint bundles. */
export const AUDIT_CHECKPOINT_BUNDLE_VERSION = "1";

/** Default maximum number of entries included in a checkpoint bundle. */
export const DEFAULT_AUDIT_CHECKPOINT_LIMIT = 100;

/** Hard upper bound on entries included in a single checkpoint bundle. */
export const MAX_AUDIT_CHECKPOINT_LIMIT = 1000;

export type AuditCheckpointSignatureAlgorithm = "hmac-sha256" | "ed25519";

export interface AuditCheckpointEntry {
  id?: string;
  sequenceNumber: number;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  denialReason?: string | null;
  scopesRequired?: string[] | null;
  previousHash: string;
  entryHash: string;
  chainVersion: string;
  createdAt: string;
}

export interface AuditCheckpointBoundaries {
  startSequence: number | null;
  endSequence: number | null;
  startEntryHash: string | null;
  endEntryHash: string | null;
  /** The previousHash of the first entry in the bundle (`"GENESIS"` or predecessor's entryHash). */
  previousChainHash: string | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  entryCount: number;
  limit: number;
  truncated: boolean;
}

export interface AuditCheckpointPayload {
  bundleVersion: string;
  domain: string;
  chainVersion: string | null;
  talosId: string;
  exportedAt: string;
  chainRoot: string | null;
  entriesDigest: string;
  boundaries: AuditCheckpointBoundaries;
}

export interface AuditCheckpointSignature {
  algorithm: AuditCheckpointSignatureAlgorithm;
  value: string;
  publicKey?: string | null;
  keyId?: string | null;
}

export interface AuditCheckpointBundle extends AuditCheckpointPayload {
  entries: AuditCheckpointEntry[];
  signature: AuditCheckpointSignature | null;
  /** Backward-compatible alias for the root HMAC seal when signed with HMAC-SHA256. */
  seal: string | null;
}

export type AuditCheckpointRowInput = {
  id?: string;
  sequenceNumber: number | null;
  entryHash: string | null;
  previousHash: string | null;
  chainVersion: string | null;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  denialReason?: string | null;
  scopesRequired?: string[] | null;
  createdAt: Date | string;
};

export interface CreateAuditCheckpointBundleOptions {
  talosId: string;
  rows: AuditCheckpointRowInput[];
  /** Bounded entry limit (clamped to `[1, MAX_AUDIT_CHECKPOINT_LIMIT]`). */
  limit?: number;
  /** Optional explicit inclusive lower sequence bound. */
  fromSequence?: number;
  /** Optional explicit inclusive upper sequence bound. */
  toSequence?: number;
  /** Optional explicit truncation flag if the caller already sliced with `limit + 1`. */
  truncated?: boolean;
  /** Timestamp for the bundle export (defaults to current time). */
  exportedAt?: Date | string;
  /** Optional HMAC-SHA256 secret to sign the checkpoint bundle. */
  hmacSecret?: string | null;
  /** Optional Ed25519 private key (PEM or KeyObject) for asymmetric offline verification. */
  privateKey?: string | KeyObject | null;
  /** Optional Ed25519 public key (PEM) embedded in the signature metadata. */
  publicKey?: string | null;
  /** Optional key identifier for key rotation tracking. */
  keyId?: string | null;
}

export type AuditCheckpointVerificationFailureReason =
  | "invalid_bundle_structure"
  | "unsupported_bundle_version"
  | "domain_mismatch"
  | "missing_verification_key"
  | "invalid_signature"
  | "entries_digest_mismatch"
  | "boundary_mismatch"
  | "chain_root_mismatch"
  | "entry_count_exceeds_limit"
  | "talos_id_mismatch"
  | "sequence_gap"
  | "previous_hash_mismatch"
  | "entry_hash_mismatch";

export interface AuditCheckpointVerificationResult {
  valid: boolean;
  signatureValid: boolean;
  boundariesValid: boolean;
  chainValid: boolean;
  verifiedEntries: number;
  brokenAtSequence: number | null;
  failureReason: AuditCheckpointVerificationFailureReason | null;
  talosId: string | null;
  chainRoot: string | null;
  boundaries: AuditCheckpointBoundaries | null;
}

export interface VerifyAuditCheckpointBundleOptions {
  /** Shared HMAC secret when verifying `hmac-sha256` bundles. */
  hmacSecret?: string | null;
  /** Ed25519 public key (PEM or KeyObject) when verifying `ed25519` bundles. */
  publicKey?: string | KeyObject | null;
  /** Expected talosId; if provided, bundle is rejected if `bundle.talosId !== expectedTalosId`. */
  expectedTalosId?: string;
  /** Expected previousChainHash anchor (e.g. from a prior checkpoint's `chainRoot`). */
  expectedPreviousChainHash?: string;
  /** Maximum allowed entries in the bundle (defaults to `MAX_AUDIT_CHECKPOINT_LIMIT`). */
  maxEntries?: number;
  /** Whether a cryptographic signature is required (defaults to `true`). */
  requireSignature?: boolean;
}

/**
 * Generate an Ed25519 keypair (PEM-encoded SPKI public key and PKCS#8 private key)
 * suitable for signing and offline verification of audit checkpoint bundles.
 */
export function generateCheckpointKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Get the optional Ed25519 private key PEM for checkpoint signing from environment.
 */
export function getCheckpointSigningPrivateKey(): string | null {
  const raw = process.env.AUDIT_CHECKPOINT_PRIVATE_KEY;
  if (!raw || !raw.trim()) return null;
  return raw.replace(/\\n/g, "\n").trim();
}

/**
 * Get the optional Ed25519 public key PEM for checkpoint verification from environment.
 */
export function getCheckpointVerificationPublicKey(): string | null {
  const raw = process.env.AUDIT_CHECKPOINT_PUBLIC_KEY;
  if (!raw || !raw.trim()) return null;
  return raw.replace(/\\n/g, "\n").trim();
}

/**
 * Clamp a requested checkpoint entry limit to `[1, MAX_AUDIT_CHECKPOINT_LIMIT]`.
 */
export function clampCheckpointLimit(limit?: number | null): number {
  if (limit === undefined || limit === null || Number.isNaN(Number(limit))) {
    return DEFAULT_AUDIT_CHECKPOINT_LIMIT;
  }
  const n = Math.floor(Number(limit));
  return Math.min(Math.max(n, 1), MAX_AUDIT_CHECKPOINT_LIMIT);
}

/**
 * Compute a deterministic SHA-256 hex digest over the ordered checkpoint entries.
 */
export function computeCheckpointEntriesDigest(
  entries: ReadonlyArray<AuditCheckpointEntry>,
): string {
  const canonicalEntries = entries.map((e) => ({
    sequenceNumber: e.sequenceNumber,
    talosId: e.talosId,
    method: e.method,
    path: e.path,
    statusCode: e.statusCode,
    ipAddress: e.ipAddress,
    previousHash: e.previousHash,
    entryHash: e.entryHash,
    chainVersion: e.chainVersion,
    createdAt: e.createdAt,
  }));
  const payload = `${AUDIT_CHECKPOINT_DOMAIN}:entries:${JSON.stringify(canonicalEntries)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Deterministic canonical JSON encoding of the checkpoint payload and boundaries
 * used as the signing input.
 */
export function canonicalizeCheckpointPayload(
  payload: AuditCheckpointPayload,
): string {
  const b = payload.boundaries;
  return JSON.stringify({
    bundleVersion: payload.bundleVersion,
    domain: payload.domain,
    chainVersion: payload.chainVersion,
    talosId: payload.talosId,
    exportedAt: payload.exportedAt,
    chainRoot: payload.chainRoot,
    entriesDigest: payload.entriesDigest,
    boundaries: {
      startSequence: b.startSequence,
      endSequence: b.endSequence,
      startEntryHash: b.startEntryHash,
      endEntryHash: b.endEntryHash,
      previousChainHash: b.previousChainHash,
      startTimestamp: b.startTimestamp,
      endTimestamp: b.endTimestamp,
      entryCount: b.entryCount,
      limit: b.limit,
      truncated: b.truncated,
    },
  });
}

/**
 * Sign a canonical checkpoint payload using Ed25519 or HMAC-SHA256.
 */
export function signCheckpointPayload(
  payload: AuditCheckpointPayload,
  options: {
    hmacSecret?: string | null;
    privateKey?: string | KeyObject | null;
    publicKey?: string | null;
    keyId?: string | null;
  },
): AuditCheckpointSignature | null {
  const signingInput = `${AUDIT_CHECKPOINT_DOMAIN}:${canonicalizeCheckpointPayload(payload)}`;

  if (options.privateKey) {
    const keyObj =
      typeof options.privateKey === "string"
        ? createPrivateKey(options.privateKey)
        : options.privateKey;
    const derivedPub =
      options.publicKey ??
      createPublicKey(keyObj).export({ type: "spki", format: "pem" }).toString();
    const sigHex = cryptoSign(null, Buffer.from(signingInput, "utf8"), keyObj).toString("hex");
    return {
      algorithm: "ed25519",
      value: sigHex,
      publicKey: derivedPub,
      keyId: options.keyId ?? null,
    };
  }

  if (options.hmacSecret) {
    const sigHex = createHmac("sha256", options.hmacSecret)
      .update(signingInput, "utf8")
      .digest("hex");
    return {
      algorithm: "hmac-sha256",
      value: sigHex,
      keyId: options.keyId ?? null,
    };
  }

  return null;
}

/**
 * Verify a checkpoint payload signature offline using the provided key material.
 */
export function verifyCheckpointSignature(
  payload: AuditCheckpointPayload,
  signature: AuditCheckpointSignature | null | undefined,
  options: {
    hmacSecret?: string | null;
    publicKey?: string | KeyObject | null;
  } = {},
): { ok: boolean; reason?: "missing_verification_key" | "invalid_signature" } {
  if (!signature || typeof signature.value !== "string" || !signature.value) {
    return { ok: false, reason: "invalid_signature" };
  }

  const signingInput = `${AUDIT_CHECKPOINT_DOMAIN}:${canonicalizeCheckpointPayload(payload)}`;

  if (signature.algorithm === "ed25519") {
    const keySource = options.publicKey ?? signature.publicKey ?? null;
    if (!keySource) {
      return { ok: false, reason: "missing_verification_key" };
    }
    if (!/^[0-9a-f]{128}$/i.test(signature.value)) {
      return { ok: false, reason: "invalid_signature" };
    }
    try {
      const pubKeyObj =
        typeof keySource === "string" ? createPublicKey(keySource) : keySource;
      const verified = cryptoVerify(
        null,
        Buffer.from(signingInput, "utf8"),
        pubKeyObj,
        Buffer.from(signature.value, "hex"),
      );
      return verified ? { ok: true } : { ok: false, reason: "invalid_signature" };
    } catch {
      return { ok: false, reason: "invalid_signature" };
    }
  }

  if (signature.algorithm === "hmac-sha256") {
    if (!options.hmacSecret) {
      return { ok: false, reason: "missing_verification_key" };
    }
    if (!/^[0-9a-f]{64}$/.test(signature.value)) {
      return { ok: false, reason: "invalid_signature" };
    }
    const expected = createHmac("sha256", options.hmacSecret)
      .update(signingInput, "utf8")
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature.value, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "invalid_signature" };
}

function normalizeIsoTimestamp(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid timestamp in audit checkpoint");
  }
  return d.toISOString();
}

/**
 * Create a bounded, signed audit checkpoint bundle with explicit chain boundaries.
 *
 * Rows without chain columns (`sequenceNumber`, `entryHash`, `previousHash`, `chainVersion`)
 * are filtered out, the remaining chained entries are ordered by `sequenceNumber` ascending,
 * filtered by optional `[fromSequence, toSequence]` bounds, and bounded to `limit`.
 */
export function createAuditCheckpointBundle(
  options: CreateAuditCheckpointBundleOptions,
): AuditCheckpointBundle {
  const limit = clampCheckpointLimit(options.limit);
  const exportedAt = normalizeIsoTimestamp(options.exportedAt ?? new Date());

  if (
    options.fromSequence !== undefined &&
    options.toSequence !== undefined &&
    options.fromSequence > options.toSequence
  ) {
    throw new Error("fromSequence must be less than or equal to toSequence");
  }

  const chained: AuditCheckpointEntry[] = [];
  for (const row of options.rows) {
    if (
      row.sequenceNumber === null ||
      row.sequenceNumber === undefined ||
      !row.entryHash ||
      !row.previousHash ||
      !row.chainVersion
    ) {
      continue;
    }
    if (
      options.fromSequence !== undefined &&
      row.sequenceNumber < options.fromSequence
    ) {
      continue;
    }
    if (
      options.toSequence !== undefined &&
      row.sequenceNumber > options.toSequence
    ) {
      continue;
    }

    chained.push({
      ...(row.id !== undefined ? { id: row.id } : {}),
      sequenceNumber: row.sequenceNumber,
      talosId: row.talosId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      ipAddress: row.ipAddress ?? null,
      ...(row.denialReason !== undefined ? { denialReason: row.denialReason } : {}),
      ...(row.scopesRequired !== undefined
        ? { scopesRequired: row.scopesRequired }
        : {}),
      previousHash: row.previousHash,
      entryHash: row.entryHash,
      chainVersion: row.chainVersion,
      createdAt: normalizeIsoTimestamp(row.createdAt),
    });
  }

  chained.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const exceededLimit = chained.length > limit;
  // When rows exceed limit, keep the most recent `limit` contiguous entries by default
  // unless `fromSequence` was explicitly requested (in which case take from the lower bound).
  const boundedEntries = exceededLimit
    ? options.fromSequence !== undefined
      ? chained.slice(0, limit)
      : chained.slice(chained.length - limit)
    : chained;

  const truncated = Boolean(options.truncated) || exceededLimit;
  const firstEntry = boundedEntries[0] ?? null;
  const lastEntry = boundedEntries[boundedEntries.length - 1] ?? null;

  const boundaries: AuditCheckpointBoundaries = {
    startSequence: firstEntry ? firstEntry.sequenceNumber : null,
    endSequence: lastEntry ? lastEntry.sequenceNumber : null,
    startEntryHash: firstEntry ? firstEntry.entryHash : null,
    endEntryHash: lastEntry ? lastEntry.entryHash : null,
    previousChainHash: firstEntry ? firstEntry.previousHash : null,
    startTimestamp: firstEntry ? firstEntry.createdAt : null,
    endTimestamp: lastEntry ? lastEntry.createdAt : null,
    entryCount: boundedEntries.length,
    limit,
    truncated,
  };

  const chainRoot = lastEntry ? lastEntry.entryHash : null;
  const chainVersion = lastEntry ? lastEntry.chainVersion : null;
  const entriesDigest = computeCheckpointEntriesDigest(boundedEntries);

  const payload: AuditCheckpointPayload = {
    bundleVersion: AUDIT_CHECKPOINT_BUNDLE_VERSION,
    domain: AUDIT_CHECKPOINT_DOMAIN,
    chainVersion,
    talosId: options.talosId,
    exportedAt,
    chainRoot,
    entriesDigest,
    boundaries,
  };

  const privateKey = options.privateKey !== undefined
    ? options.privateKey
    : getCheckpointSigningPrivateKey();
  const publicKey = options.publicKey !== undefined
    ? options.publicKey
    : getCheckpointVerificationPublicKey();
  const hmacSecret = options.hmacSecret !== undefined
    ? options.hmacSecret
    : getChainHmacSecret();

  const signature = signCheckpointPayload(payload, {
    privateKey,
    publicKey,
    hmacSecret,
    keyId: options.keyId ?? null,
  });

  const seal =
    chainRoot && hmacSecret ? sealChainRoot(chainRoot, hmacSecret) : null;

  return {
    ...payload,
    entries: boundedEntries,
    signature,
    seal,
  };
}

/**
 * Verify an exported audit checkpoint bundle completely offline without
 * database connectivity or administrator credentials.
 *
 * Checks:
 *   1. Structural integrity, domain separator, and bundle schema version.
 *   2. Bounded size (`entryCount <= limit <= maxEntries`) and exact boundary consistency
 *      (`startSequence`, `endSequence`, `startEntryHash`, `endEntryHash`,
 *      `previousChainHash`, `startTimestamp`, `endTimestamp`, `chainRoot`).
 *   3. Entries digest match (`computeCheckpointEntriesDigest(entries) === entriesDigest`).
 *   4. Per-entry cryptographic hash recomputation (`computeEntryHash`), contiguous
 *      sequence numbering from `boundaries.startSequence` to `boundaries.endSequence`,
 *      and `previousHash` linkage starting from `boundaries.previousChainHash`.
 *   5. Cryptographic signature verification (Ed25519 public key or HMAC-SHA256 secret).
 */
export function verifyAuditCheckpointBundle(
  bundleInput: unknown,
  options: VerifyAuditCheckpointBundleOptions = {},
): AuditCheckpointVerificationResult {
  const invalidResult = (
    failureReason: AuditCheckpointVerificationFailureReason,
    partial: Partial<AuditCheckpointVerificationResult> = {},
  ): AuditCheckpointVerificationResult => ({
    valid: false,
    signatureValid: false,
    boundariesValid: false,
    chainValid: false,
    verifiedEntries: 0,
    brokenAtSequence: null,
    failureReason,
    talosId: null,
    chainRoot: null,
    boundaries: null,
    ...partial,
  });

  let bundle: AuditCheckpointBundle;
  if (typeof bundleInput === "string") {
    try {
      bundle = JSON.parse(bundleInput) as AuditCheckpointBundle;
    } catch {
      return invalidResult("invalid_bundle_structure");
    }
  } else if (bundleInput && typeof bundleInput === "object") {
    bundle = bundleInput as AuditCheckpointBundle;
  } else {
    return invalidResult("invalid_bundle_structure");
  }

  if (
    !bundle ||
    typeof bundle !== "object" ||
    typeof bundle.talosId !== "string" ||
    !bundle.talosId.trim() ||
    typeof bundle.exportedAt !== "string" ||
    typeof bundle.entriesDigest !== "string" ||
    !Array.isArray(bundle.entries) ||
    !bundle.boundaries ||
    typeof bundle.boundaries !== "object"
  ) {
    return invalidResult("invalid_bundle_structure");
  }

  if (bundle.bundleVersion !== AUDIT_CHECKPOINT_BUNDLE_VERSION) {
    return invalidResult("unsupported_bundle_version", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: bundle.boundaries,
    });
  }

  if (bundle.domain !== AUDIT_CHECKPOINT_DOMAIN) {
    return invalidResult("domain_mismatch", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: bundle.boundaries,
    });
  }

  if (
    options.expectedTalosId !== undefined &&
    bundle.talosId !== options.expectedTalosId
  ) {
    return invalidResult("talos_id_mismatch", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: bundle.boundaries,
    });
  }

  const b = bundle.boundaries;
  const maxEntries = options.maxEntries ?? MAX_AUDIT_CHECKPOINT_LIMIT;
  if (
    typeof b.entryCount !== "number" ||
    typeof b.limit !== "number" ||
    typeof b.truncated !== "boolean" ||
    b.limit < 1 ||
    b.limit > maxEntries ||
    b.entryCount < 0 ||
    b.entryCount > b.limit ||
    b.entryCount > maxEntries ||
    bundle.entries.length > b.limit ||
    bundle.entries.length > maxEntries
  ) {
    return invalidResult("entry_count_exceeds_limit", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: b,
    });
  }

  // Verify entries digest
  const recomputedDigest = computeCheckpointEntriesDigest(bundle.entries);
  if (recomputedDigest !== bundle.entriesDigest) {
    return invalidResult("entries_digest_mismatch", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: b,
    });
  }

  // Verify boundary metadata against entries
  if (b.entryCount !== bundle.entries.length) {
    return invalidResult("boundary_mismatch", {
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot ?? null,
      boundaries: b,
    });
  }

  if (bundle.entries.length === 0) {
    if (
      b.startSequence !== null ||
      b.endSequence !== null ||
      b.startEntryHash !== null ||
      b.endEntryHash !== null ||
      b.previousChainHash !== null ||
      b.startTimestamp !== null ||
      b.endTimestamp !== null
    ) {
      return invalidResult("boundary_mismatch", {
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
    if (bundle.chainRoot !== null) {
      return invalidResult("chain_root_mismatch", {
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot,
        boundaries: b,
      });
    }
  } else {
    const first = bundle.entries[0];
    const last = bundle.entries[bundle.entries.length - 1];
    if (
      b.startSequence !== first.sequenceNumber ||
      b.endSequence !== last.sequenceNumber ||
      b.startEntryHash !== first.entryHash ||
      b.endEntryHash !== last.entryHash ||
      b.previousChainHash !== first.previousHash ||
      b.startTimestamp !== first.createdAt ||
      b.endTimestamp !== last.createdAt
    ) {
      return invalidResult("boundary_mismatch", {
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
    if (bundle.chainRoot !== last.entryHash) {
      return invalidResult("chain_root_mismatch", {
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
    if (
      options.expectedPreviousChainHash !== undefined &&
      b.previousChainHash !== options.expectedPreviousChainHash
    ) {
      return invalidResult("boundary_mismatch", {
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
    if (first.sequenceNumber === 0 && b.previousChainHash !== GENESIS_HASH) {
      return invalidResult("previous_hash_mismatch", {
        boundariesValid: true,
        brokenAtSequence: 0,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
    if (first.sequenceNumber > 0 && b.previousChainHash === GENESIS_HASH) {
      return invalidResult("previous_hash_mismatch", {
        boundariesValid: true,
        brokenAtSequence: first.sequenceNumber,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }
  }

  // Verify hash chain across all entries within the bounded range
  let expectedSequence =
    bundle.entries.length > 0 ? bundle.entries[0].sequenceNumber : 0;
  let expectedPreviousHash =
    bundle.entries.length > 0 ? b.previousChainHash : GENESIS_HASH;
  let verifiedCount = 0;

  for (const entry of bundle.entries) {
    if (entry.talosId !== bundle.talosId) {
      return invalidResult("talos_id_mismatch", {
        boundariesValid: true,
        verifiedEntries: verifiedCount,
        brokenAtSequence: entry.sequenceNumber,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }

    if (entry.sequenceNumber !== expectedSequence) {
      return invalidResult("sequence_gap", {
        boundariesValid: true,
        verifiedEntries: verifiedCount,
        brokenAtSequence: entry.sequenceNumber,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }

    if (entry.previousHash !== expectedPreviousHash) {
      return invalidResult("previous_hash_mismatch", {
        boundariesValid: true,
        verifiedEntries: verifiedCount,
        brokenAtSequence: entry.sequenceNumber,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }

    const recomputedHash = computeEntryHash({
      sequenceNumber: entry.sequenceNumber,
      talosId: entry.talosId,
      method: entry.method,
      path: entry.path,
      statusCode: entry.statusCode,
      ipAddress: entry.ipAddress,
      createdAt: entry.createdAt,
    });

    if (recomputedHash !== entry.entryHash) {
      return invalidResult("entry_hash_mismatch", {
        boundariesValid: true,
        verifiedEntries: verifiedCount,
        brokenAtSequence: entry.sequenceNumber,
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot ?? null,
        boundaries: b,
      });
    }

    expectedPreviousHash = entry.entryHash;
    expectedSequence = entry.sequenceNumber + 1;
    verifiedCount++;
  }

  // Verify cryptographic signature
  const requireSignature = options.requireSignature ?? true;
  const payload: AuditCheckpointPayload = {
    bundleVersion: bundle.bundleVersion,
    domain: bundle.domain,
    chainVersion: bundle.chainVersion,
    talosId: bundle.talosId,
    exportedAt: bundle.exportedAt,
    chainRoot: bundle.chainRoot,
    entriesDigest: bundle.entriesDigest,
    boundaries: b,
  };

  let signatureValid = false;
  if (bundle.signature) {
    const sigCheck = verifyCheckpointSignature(payload, bundle.signature, {
      hmacSecret: options.hmacSecret,
      publicKey: options.publicKey,
    });
    if (!sigCheck.ok) {
      return {
        valid: false,
        signatureValid: false,
        boundariesValid: true,
        chainValid: true,
        verifiedEntries: verifiedCount,
        brokenAtSequence: null,
        failureReason: sigCheck.reason ?? "invalid_signature",
        talosId: bundle.talosId,
        chainRoot: bundle.chainRoot,
        boundaries: b,
      };
    }
    signatureValid = true;
  } else if (requireSignature) {
    return {
      valid: false,
      signatureValid: false,
      boundariesValid: true,
      chainValid: true,
      verifiedEntries: verifiedCount,
      brokenAtSequence: null,
      failureReason: "invalid_signature",
      talosId: bundle.talosId,
      chainRoot: bundle.chainRoot,
      boundaries: b,
    };
  }

  return {
    valid: true,
    signatureValid,
    boundariesValid: true,
    chainValid: true,
    verifiedEntries: verifiedCount,
    brokenAtSequence: null,
    failureReason: null,
    talosId: bundle.talosId,
    chainRoot: bundle.chainRoot,
    boundaries: b,
  };
}

