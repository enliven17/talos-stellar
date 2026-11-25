import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  lte,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { KeyObject } from "node:crypto";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import {
  clampCheckpointLimit,
  buildAuditExportFilename,
  createAuditCheckpointBundle,
  getChainHmacSecret,
  getCheckpointVerificationPublicKey,
  verifyChainRange,
  type AuditChainPredecessor,
  type AuditExportFormat,
  type AuditCheckpointBundle,
  type AuditCheckpointRowInput,
  type ChainRangeVerificationResult,
} from "@/lib/audit-chain";
import {
  getAuditRetentionPolicy,
  isAuditRetentionEnabled,
  planAuditRetention,
  type AuditRetentionPlan,
  type AuditRetentionPolicy,
} from "./retention";
import {
  AuditLogFilterError,
  escapeIlikePattern,
  statusClassRange,
  validateAuditLogFilters,
  type AuditLogFilters,
} from "./filters";
import type { AuditLogRecord } from "./types";

function toRecord(row: typeof tlsApiAuditLogs.$inferSelect): AuditLogRecord {
  return {
    id: row.id,
    talosId: row.talosId,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    denialReason: row.denialReason ?? null,
    scopesRequired: (row.scopesRequired as string[] | null) ?? null,
    ipAddress: row.ipAddress ?? null,
    sequenceNumber: row.sequenceNumber ?? null,
    previousHash: row.previousHash ?? null,
    entryHash: row.entryHash ?? null,
    chainVersion: row.chainVersion ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * List API audit-log rows for operator inspection, newest first.
 * Supports searchable filters (path substring, method, status, talos, dates).
 * Never returns request bodies, API keys, or other secrets — only the
 * identifier fields already stored on `tls_api_audit_logs`.
 */
export async function listAuditLogs(
  filter: AuditLogFilters,
): Promise<{ logs: AuditLogRecord[]; nextCursor: string | null }> {
  const validated = validateAuditLogFilters(filter);
  if (!validated.ok) {
    throw new AuditLogFilterError(validated.error);
  }
  const safeFilter = validated.filters;

  const limit = Math.min(Math.max(safeFilter.limit ?? 50, 1), 200);
  const conditions: SQL[] = [];

  if (safeFilter.talosId) {
    conditions.push(eq(tlsApiAuditLogs.talosId, safeFilter.talosId));
  }
  if (safeFilter.method) {
    conditions.push(eq(tlsApiAuditLogs.method, safeFilter.method));
  }
  if (safeFilter.statusCode !== undefined) {
    conditions.push(eq(tlsApiAuditLogs.statusCode, safeFilter.statusCode));
  }
  if (safeFilter.statusClass) {
    const { min, max } = statusClassRange(safeFilter.statusClass);
    conditions.push(gte(tlsApiAuditLogs.statusCode, min));
    conditions.push(lte(tlsApiAuditLogs.statusCode, max));
  }
  if (safeFilter.denialReason) {
    conditions.push(eq(tlsApiAuditLogs.denialReason, safeFilter.denialReason));
  }
  if (safeFilter.q) {
    const pattern = `%${escapeIlikePattern(safeFilter.q)}%`;
    // ESCAPE so literal %/_ in the query don't act as wildcards.
    const pathMatch = sql`${tlsApiAuditLogs.path} ILIKE ${pattern} ESCAPE '\\'`;
    const reasonMatch = sql`${tlsApiAuditLogs.denialReason} ILIKE ${pattern} ESCAPE '\\'`;
    conditions.push(or(pathMatch, reasonMatch)!);
  }
  if (safeFilter.from) {
    conditions.push(gte(tlsApiAuditLogs.createdAt, new Date(safeFilter.from)));
  }
  if (safeFilter.to) {
    conditions.push(lte(tlsApiAuditLogs.createdAt, new Date(safeFilter.to)));
  }
  if (safeFilter.cursor) {
    conditions.push(lt(tlsApiAuditLogs.createdAt, new Date(safeFilter.cursor)));
  }

  const rows = await db
    .select()
    .from(tlsApiAuditLogs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tlsApiAuditLogs.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? page[page.length - 1]?.createdAt.toISOString() ?? null
    : null;

  return { logs: page.map(toRecord), nextCursor };
}

export async function getAgentAuditReviewBundle(
  talosId: string,
  limit: number,
  cursor?: string,
): Promise<{
  auditReferences: AuditLogRecord[];
  nextCursor: string | null;
  checkpoint: {
    chainRoot: string | null;
    totalEntries: number;
    chainVersion: string | null;
    createdAt: string;
  };
}> {
  const referenceConditions = [eq(tlsApiAuditLogs.talosId, talosId)];
  if (cursor) referenceConditions.push(lt(tlsApiAuditLogs.createdAt, new Date(cursor)));

  const [rows, latestRows, countRows] = await Promise.all([
    db
      .select()
      .from(tlsApiAuditLogs)
      .where(and(...referenceConditions))
      .orderBy(desc(tlsApiAuditLogs.createdAt))
      .limit(limit + 1),
    db
      .select({
        entryHash: tlsApiAuditLogs.entryHash,
        chainVersion: tlsApiAuditLogs.chainVersion,
      })
      .from(tlsApiAuditLogs)
      .where(and(eq(tlsApiAuditLogs.talosId, talosId), isNotNull(tlsApiAuditLogs.entryHash)))
      .orderBy(desc(tlsApiAuditLogs.createdAt))
      .limit(1),
    db
      .select({ total: count() })
      .from(tlsApiAuditLogs)
      .where(and(eq(tlsApiAuditLogs.talosId, talosId), isNotNull(tlsApiAuditLogs.entryHash))),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const latest = latestRows[0] ?? null;

  return {
    auditReferences: page.map(toRecord),
    nextCursor: hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null,
    checkpoint: {
      chainRoot: latest?.entryHash ?? null,
      totalEntries: countRows[0]?.total ?? 0,
      chainVersion: latest?.chainVersion ?? null,
      createdAt: new Date().toISOString(),
    },
  };
}

const AUDIT_EXPORT_COLUMNS = [
  "id",
  "talosId",
  "method",
  "path",
  "statusCode",
  "denialReason",
  "scopesRequired",
  "ipAddress",
  "sequenceNumber",
  "previousHash",
  "entryHash",
  "chainVersion",
  "createdAt",
] as const satisfies ReadonlyArray<keyof AuditLogRecord>;

function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(" ")
        : String(value);
  // Neutralize spreadsheet formula prefixes (CSV injection).
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Serialize audit records for export. Unicode is preserved verbatim; CSV
 * cells are quoted and formula-prefixed cells are neutralized.
 */
export function serializeAuditLogExport(
  logs: AuditLogRecord[],
  options: {
    format: AuditExportFormat;
    exportedAt?: Date | string;
    filters?: AuditLogFilters;
    nextCursor?: string | null;
  },
): string {
  if (options.format === "csv") {
    const lines = [AUDIT_EXPORT_COLUMNS.join(",")];
    for (const log of logs) {
      lines.push(AUDIT_EXPORT_COLUMNS.map((col) => csvCell(log[col])).join(","));
    }
    return `${lines.join("\r\n")}\r\n`;
  }
  const exportedAt =
    options.exportedAt instanceof Date
      ? options.exportedAt.toISOString()
      : options.exportedAt ?? new Date().toISOString();
  return JSON.stringify(
    {
      exportedAt,
      filters: options.filters ?? {},
      nextCursor: options.nextCursor ?? null,
      logs,
    },
    null,
    2,
  );
}

export interface AuditLogExport {
  filename: string;
  contentDisposition: string;
  contentType: string;
  data: string;
}

/**
 * Export a filtered page of audit records as JSON or CSV with a bounded,
 * header-safe filename (see `buildAuditExportFilename`). Pass `logs` when the
 * caller already fetched the page; otherwise it is queried with the filters.
 */
export async function exportAuditLogs(
  filter: AuditLogFilters,
  options: {
    format: AuditExportFormat;
    exportedAt?: Date;
    logs?: AuditLogRecord[];
    nextCursor?: string | null;
  },
): Promise<AuditLogExport> {
  const exportedAt = options.exportedAt ?? new Date();
  let logs = options.logs;
  let nextCursor = options.nextCursor ?? null;
  if (logs === undefined) {
    const page = await listAuditLogs(filter);
    logs = page.logs;
    nextCursor = page.nextCursor;
  }

  const filename = buildAuditExportFilename({
    talosId: filter.talosId,
    format: options.format,
    exportedAt,
  });

  return {
    filename,
    contentDisposition: `attachment; filename="${filename}"`,
    contentType:
      options.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    data: serializeAuditLogExport(logs, {
      format: options.format,
      exportedAt,
      filters: filter,
      nextCursor,
    }),
  };
}

export interface VerifyAuditChainRangeFilter {
  talosId: string;
  /** Inclusive lower timestamp bound (ISO-8601). */
  from?: string;
  /** Inclusive upper timestamp bound (ISO-8601). */
  to?: string;
  /** Maximum entries to verify (clamped to `[1, 10000]`, default 1000). */
  limit?: number;
}

const chainRowColumns = {
  sequenceNumber: tlsApiAuditLogs.sequenceNumber,
  entryHash: tlsApiAuditLogs.entryHash,
  previousHash: tlsApiAuditLogs.previousHash,
  chainVersion: tlsApiAuditLogs.chainVersion,
  talosId: tlsApiAuditLogs.talosId,
  method: tlsApiAuditLogs.method,
  path: tlsApiAuditLogs.path,
  statusCode: tlsApiAuditLogs.statusCode,
  ipAddress: tlsApiAuditLogs.ipAddress,
  createdAt: tlsApiAuditLogs.createdAt,
};

/**
 * Verify an agent's audit chain over an inclusive `[from, to]` time window.
 *
 * When `from` is set, the last chained entry strictly before it is fetched as
 * the predecessor boundary, so a mid-chain window verifies as complete. A
 * window truncated by `limit` is reported as incomplete, never as valid.
 */
export async function verifyAuditChainRange(
  filter: VerifyAuditChainRangeFilter,
): Promise<ChainRangeVerificationResult> {
  const limit = Math.min(Math.max(Math.floor(Number(filter.limit) || 1000), 1), 10000);
  const fromDate = filter.from !== undefined ? new Date(filter.from) : null;
  const toDate = filter.to !== undefined ? new Date(filter.to) : null;

  const base = [eq(tlsApiAuditLogs.talosId, filter.talosId), isNotNull(tlsApiAuditLogs.entryHash)];

  let predecessor: AuditChainPredecessor | null = null;
  if (fromDate !== null) {
    const predecessorRows = await db
      .select({
        sequenceNumber: tlsApiAuditLogs.sequenceNumber,
        entryHash: tlsApiAuditLogs.entryHash,
        createdAt: tlsApiAuditLogs.createdAt,
      })
      .from(tlsApiAuditLogs)
      .where(and(...base, lt(tlsApiAuditLogs.createdAt, fromDate)))
      .orderBy(desc(tlsApiAuditLogs.createdAt), desc(tlsApiAuditLogs.sequenceNumber))
      .limit(1);
    predecessor = predecessorRows[0] ?? null;
  }

  const conditions = [...base];
  if (fromDate !== null) conditions.push(gte(tlsApiAuditLogs.createdAt, fromDate));
  if (toDate !== null) conditions.push(lte(tlsApiAuditLogs.createdAt, toDate));

  const rows = await db
    .select(chainRowColumns)
    .from(tlsApiAuditLogs)
    .where(and(...conditions))
    .orderBy(asc(tlsApiAuditLogs.createdAt), asc(tlsApiAuditLogs.sequenceNumber))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;

  return verifyChainRange(page, {
    predecessor,
    from: fromDate,
    to: toDate,
    truncated,
  });
}

export interface ApplyAuditRetentionOptions {
  talosId: string;
  /**
   * Signed checkpoint bundle (from `exportAuditCheckpointBundle`) that closes
   * the range to prune. Keep it: it is the signed proof of the pruned entries.
   */
  checkpoint: unknown;
  /** Policy overrides; defaults come from `AUDIT_RETENTION_*` env vars. */
  policy?: Partial<AuditRetentionPolicy>;
  /** Plan only; never delete. Allowed even when retention is disabled. */
  dryRun?: boolean;
  /** Current time (injected for testability). */
  now?: Date;
  /** HMAC secret for checkpoint verification (defaults to `AUDIT_HASH_CHAIN_SECRET`). */
  hmacSecret?: string | null;
  /** Ed25519 public key for checkpoint verification (defaults to `AUDIT_CHECKPOINT_PUBLIC_KEY`). */
  publicKey?: string | KeyObject | null;
}

export interface ApplyAuditRetentionResult {
  plan: AuditRetentionPlan;
  /** Rows actually deleted (0 for dry runs, no-ops, refusals, or when disabled). */
  deleted: number;
  dryRun: boolean;
  /** Whether `AUDIT_RETENTION_ENABLED` is on; when off, nothing is ever deleted. */
  enabled: boolean;
}

/** Thrown when the delete would remove a different row set than was verified. */
export class AuditRetentionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Audit retention aborted: expected to prune ${expected} rows, matched ${actual}`);
    this.name = "AuditRetentionConflictError";
  }
}

/**
 * Prune an agent's oldest audit entries under the retention policy while
 * preserving checkpoint continuity (see `./retention`).
 *
 * Only a verified, closed range covered by a signed checkpoint is deleted, the
 * anchor (predecessor of the surviving chain) is always kept, and legacy
 * unchained rows are never touched. The delete runs in a transaction and is
 * rolled back unless it removes exactly the verified row set.
 */
export async function applyAuditRetention(
  options: ApplyAuditRetentionOptions,
): Promise<ApplyAuditRetentionResult> {
  const talosId = options.talosId?.trim();
  if (!talosId) {
    throw new Error("talosId is required to apply audit retention");
  }
  const dryRun = options.dryRun ?? false;
  const enabled = isAuditRetentionEnabled();
  const policy = { ...getAuditRetentionPolicy(), ...options.policy };
  const now = options.now ?? new Date();

  const chained = [
    eq(tlsApiAuditLogs.talosId, talosId),
    isNotNull(tlsApiAuditLogs.entryHash),
    isNotNull(tlsApiAuditLogs.sequenceNumber),
  ];

  const latestRows = await db
    .select({ sequenceNumber: tlsApiAuditLogs.sequenceNumber })
    .from(tlsApiAuditLogs)
    .where(and(...chained))
    .orderBy(desc(tlsApiAuditLogs.sequenceNumber))
    .limit(1);
  const latestSequence = latestRows[0]?.sequenceNumber ?? null;

  // Oldest entries first, enough to cover a full batch plus the anchor.
  const batch = Math.max(1, Math.floor(Number(policy.maxPruneBatch) || 1));
  const rows = await db
    .select(chainRowColumns)
    .from(tlsApiAuditLogs)
    .where(and(...chained))
    .orderBy(asc(tlsApiAuditLogs.sequenceNumber))
    .limit(batch + 1);

  const plan = planAuditRetention({
    talosId,
    rows,
    latestSequence,
    checkpoint: options.checkpoint,
    checkpointVerification: {
      hmacSecret: options.hmacSecret !== undefined ? options.hmacSecret : getChainHmacSecret(),
      publicKey:
        options.publicKey !== undefined ? options.publicKey : getCheckpointVerificationPublicKey(),
    },
    policy,
    now,
  });

  if (plan.action !== "prune" || dryRun || !enabled) {
    return { plan, deleted: 0, dryRun, enabled };
  }

  const from = plan.pruneFromSequence as number;
  const through = plan.pruneThroughSequence as number;
  const expected = plan.pruneCount;

  const deleted = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(tlsApiAuditLogs)
      .where(
        and(
          ...chained,
          gte(tlsApiAuditLogs.sequenceNumber, from),
          lte(tlsApiAuditLogs.sequenceNumber, through),
          lte(tlsApiAuditLogs.createdAt, new Date(plan.cutoff)),
        ),
      )
      .returning({ id: tlsApiAuditLogs.id });
    if (removed.length !== expected) {
      // Throwing rolls the transaction back: nothing is pruned.
      throw new AuditRetentionConflictError(expected, removed.length);
    }
    return removed.length;
  });

  return { plan, deleted, dryRun, enabled };
}

export interface ExportAuditCheckpointFilter {
  talosId: string;
  /** Inclusive lower sequence bound. */
  fromSequence?: number;
  /** Inclusive upper sequence bound. */
  toSequence?: number;
  /** Inclusive lower timestamp bound (ISO-8601 or Date). */
  from?: string | Date;
  /** Inclusive upper timestamp bound (ISO-8601 or Date). */
  to?: string | Date;
  /** Maximum number of chained entries to include (clamped to `[1, 1000]`). */
  limit?: number;
  /** Optional export timestamp override. */
  exportedAt?: Date | string;
  /** Optional HMAC-SHA256 secret override for signing the checkpoint bundle. */
  hmacSecret?: string | null;
  /** Optional Ed25519 private key override (PEM or KeyObject) for signing. */
  privateKey?: string | KeyObject | null;
  /** Optional Ed25519 public key override (PEM) embedded in signature metadata. */
  publicKey?: string | null;
  /** Optional key identifier. */
  keyId?: string | null;
  /** Optional pre-fetched rows; when omitted, queries `tls_api_audit_logs`. */
  rows?: AuditCheckpointRowInput[];
}

/**
 * Export a bounded, cryptographically signed audit checkpoint bundle with
 * explicit chain boundaries (`startSequence`, `endSequence`, `startEntryHash`,
 * `endEntryHash`, `previousChainHash`, `startTimestamp`, `endTimestamp`,
 * `entryCount`, `limit`, `truncated`) that can be verified offline without
 * database connectivity or administrator credentials.
 */
export async function exportAuditCheckpointBundle(
  filter: ExportAuditCheckpointFilter,
): Promise<AuditCheckpointBundle> {
  if (!filter.talosId || !filter.talosId.trim()) {
    throw new Error("talosId is required to export an audit checkpoint bundle");
  }
  if (
    filter.fromSequence !== undefined &&
    (!Number.isInteger(filter.fromSequence) || filter.fromSequence < 0)
  ) {
    throw new Error("fromSequence must be a non-negative integer");
  }
  if (
    filter.toSequence !== undefined &&
    (!Number.isInteger(filter.toSequence) || filter.toSequence < 0)
  ) {
    throw new Error("toSequence must be a non-negative integer");
  }
  if (
    filter.fromSequence !== undefined &&
    filter.toSequence !== undefined &&
    filter.fromSequence > filter.toSequence
  ) {
    throw new Error("fromSequence must be less than or equal to toSequence");
  }

  const fromDate =
    filter.from !== undefined
      ? filter.from instanceof Date
        ? filter.from
        : new Date(filter.from)
      : null;
  const toDate =
    filter.to !== undefined
      ? filter.to instanceof Date
        ? filter.to
        : new Date(filter.to)
      : null;

  if (fromDate !== null && Number.isNaN(fromDate.getTime())) {
    throw new Error("from must be a valid ISO-8601 timestamp");
  }
  if (toDate !== null && Number.isNaN(toDate.getTime())) {
    throw new Error("to must be a valid ISO-8601 timestamp");
  }
  if (fromDate !== null && toDate !== null && fromDate.getTime() > toDate.getTime()) {
    throw new Error("from must be earlier than or equal to to");
  }

  const limit = clampCheckpointLimit(filter.limit);

  if (filter.rows !== undefined) {
    return createAuditCheckpointBundle({
      talosId: filter.talosId.trim(),
      rows: filter.rows,
      limit,
      fromSequence: filter.fromSequence,
      toSequence: filter.toSequence,
      exportedAt: filter.exportedAt,
      hmacSecret: filter.hmacSecret,
      privateKey: filter.privateKey,
      publicKey: filter.publicKey,
      keyId: filter.keyId,
    });
  }

  const conditions: SQL[] = [
    eq(tlsApiAuditLogs.talosId, filter.talosId.trim()),
    isNotNull(tlsApiAuditLogs.entryHash),
    isNotNull(tlsApiAuditLogs.sequenceNumber),
  ];

  if (filter.fromSequence !== undefined) {
    conditions.push(gte(tlsApiAuditLogs.sequenceNumber, filter.fromSequence));
  }
  if (filter.toSequence !== undefined) {
    conditions.push(lte(tlsApiAuditLogs.sequenceNumber, filter.toSequence));
  }
  if (fromDate !== null) {
    conditions.push(gte(tlsApiAuditLogs.createdAt, fromDate));
  }
  if (toDate !== null) {
    conditions.push(lte(tlsApiAuditLogs.createdAt, toDate));
  }

  // If a lower bound (`fromSequence` or `from`) is specified, order ascending from that bound;
  // otherwise fetch the latest `limit + 1` chained entries descending so the bundle
  // captures the latest chain tail up to the current chain root.
  const orderAscending = filter.fromSequence !== undefined || fromDate !== null;

  const rows = await db
    .select()
    .from(tlsApiAuditLogs)
    .where(and(...conditions))
    .orderBy(
      orderAscending
        ? asc(tlsApiAuditLogs.sequenceNumber)
        : desc(tlsApiAuditLogs.sequenceNumber),
    )
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;

  return createAuditCheckpointBundle({
    talosId: filter.talosId.trim(),
    rows: page,
    limit,
    fromSequence: filter.fromSequence,
    toSequence: filter.toSequence,
    truncated,
    exportedAt: filter.exportedAt,
    hmacSecret: filter.hmacSecret,
    privateKey: filter.privateKey,
    publicKey: filter.publicKey,
    keyId: filter.keyId,
  });
}
