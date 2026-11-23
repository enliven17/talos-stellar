import {
  and,
  asc,
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
  createAuditCheckpointBundle,
  type AuditCheckpointBundle,
  type AuditCheckpointRowInput,
} from "@/lib/audit-chain";
import {
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
