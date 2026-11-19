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

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  brokenAtSequence: number | null;
  chainVersion: string | null;
}

export const AUDIT_EXPORT_FORMATS = ["json", "csv"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** Maximum character length for a validated raw identifier input. */
export const MAX_AUDIT_IDENTIFIER_INPUT_LENGTH = 128;

/** Maximum character length for a sanitized identifier segment in a filename. */
export const MAX_AUDIT_FILENAME_SEGMENT_LENGTH = 32;

/** Maximum character length for a complete audit export filename. */
export const MAX_AUDIT_EXPORT_FILENAME_LENGTH = 96;

/**
 * Strict allowlist pattern for safe audit export identifiers.
 * Only ASCII alphanumeric characters, hyphens, and underscores are accepted,
 * starting with an alphanumeric character and bounded in length.
 */
const SAFE_AUDIT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Validate and normalize a trusted identifier segment for use in an audit
 * export filename.
 *
 * Returns `null` if the input is missing, exceeds bounds, contains path
 * separators, control characters, Unicode/non-ASCII actor text, or does not
 * match the strict ASCII identifier pattern (`[A-Za-z0-9][A-Za-z0-9_-]{0,31}`).
 */
export function sanitizeAuditExportIdentifier(
  rawIdentifier: string | null | undefined,
): string | null {
  if (typeof rawIdentifier !== "string") return null;
  const trimmed = rawIdentifier.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_AUDIT_IDENTIFIER_INPUT_LENGTH ||
    trimmed.length > MAX_AUDIT_FILENAME_SEGMENT_LENGTH
  ) {
    return null;
  }
  if (!SAFE_AUDIT_IDENTIFIER_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

export interface BuildAuditExportFilenameOptions {
  /**
   * Optional validated identifier (e.g. `talosId`). If untrusted actor text,
   * Unicode, path traversal, or oversized strings are passed, the segment is
   * rejected (or falls back to `"filtered"` when `allowFallback` is true).
   */
  talosId?: string | null;
  /** Export file format (`"json"` or `"csv"`, defaults to `"json"`). */
  format?: AuditExportFormat;
  /** Optional export timestamp (Date or ISO-8601 string). */
  exportedAt?: Date | string | null;
  /**
   * When false (default in strict mode if not set), invalid `talosId` values
   * fall back to `"filtered"` so untrusted actor text never enters the filename.
   * When `strict: true`, throws an Error on an invalid identifier or timestamp.
   */
  strict?: boolean;
}

function formatFilenameTimestamp(
  value: Date | string | null | undefined,
  strict: boolean,
): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    if (strict) {
      throw new Error("Invalid audit export timestamp");
    }
    return null;
  }
  // Compact UTC timestamp: YYYYMMDDTHHMMSSZ (16 ASCII chars)
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Generate a bounded, ASCII-only, Content-Disposition-safe filename for audit
 * log exports from validated identifiers.
 *
 * Untrusted actor text (free-form queries, paths, denial reasons, Unicode names,
 * or malformed IDs) is never interpolated into the filename.
 */
export function buildAuditExportFilename(
  options: BuildAuditExportFilenameOptions = {},
): string {
  const strict = options.strict ?? false;
  const format: AuditExportFormat = options.format ?? "json";
  if (!AUDIT_EXPORT_FORMATS.includes(format)) {
    throw new Error(`Invalid audit export format: ${String(format)}`);
  }

  let scopeSegment = "all";
  if (options.talosId !== undefined && options.talosId !== null && options.talosId !== "") {
    const safeId = sanitizeAuditExportIdentifier(options.talosId);
    if (!safeId) {
      if (strict) {
        throw new Error("Invalid audit export identifier");
      }
      scopeSegment = "filtered";
    } else {
      scopeSegment = safeId;
    }
  }

  const tsSegment = formatFilenameTimestamp(options.exportedAt, strict);
  const baseName = tsSegment
    ? `audit-logs-${scopeSegment}-${tsSegment}`
    : `audit-logs-${scopeSegment}`;
  const filename = `${baseName}.${format}`;

  if (
    filename.length > MAX_AUDIT_EXPORT_FILENAME_LENGTH ||
    !/^[a-z0-9][A-Za-z0-9_-]*\.(json|csv)$/.test(filename)
  ) {
    throw new Error("Generated audit export filename failed safety bounds");
  }

  return filename;
}

/**
 * Verify a sequence of audit log entries against the hash chain.
 *
 * Each entry must satisfy:
 *   1. entryHash === computeEntryHash(entry)
 *   2. previousHash === entryHash of the preceding entry (or GENESIS for seq 0)
 *   3. sequenceNumber is sequential (0, 1, 2, ...)
 */
export function verifyChain(
  rows: Array<{
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
  }>,
): ChainVerificationResult {
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
