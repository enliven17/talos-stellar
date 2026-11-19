import { and, asc, desc, eq, gte, isNotNull, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import {
  verifyChainRange,
  type AuditChainPredecessor,
  type ChainRangeVerificationResult,
} from "@/lib/audit-chain";
import {
  escapeIlikePattern,
  statusClassRange,
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
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const conditions: SQL[] = [];

  if (filter.talosId) {
    conditions.push(eq(tlsApiAuditLogs.talosId, filter.talosId));
  }
  if (filter.method) {
    conditions.push(eq(tlsApiAuditLogs.method, filter.method));
  }
  if (filter.statusCode !== undefined) {
    conditions.push(eq(tlsApiAuditLogs.statusCode, filter.statusCode));
  }
  if (filter.statusClass) {
    const { min, max } = statusClassRange(filter.statusClass);
    conditions.push(gte(tlsApiAuditLogs.statusCode, min));
    conditions.push(lte(tlsApiAuditLogs.statusCode, max));
  }
  if (filter.denialReason) {
    conditions.push(eq(tlsApiAuditLogs.denialReason, filter.denialReason));
  }
  if (filter.q) {
    const pattern = `%${escapeIlikePattern(filter.q)}%`;
    // ESCAPE so literal %/_ in the query don't act as wildcards.
    const pathMatch = sql`${tlsApiAuditLogs.path} ILIKE ${pattern} ESCAPE '\\'`;
    const reasonMatch = sql`${tlsApiAuditLogs.denialReason} ILIKE ${pattern} ESCAPE '\\'`;
    conditions.push(or(pathMatch, reasonMatch)!);
  }
  if (filter.from) {
    conditions.push(gte(tlsApiAuditLogs.createdAt, new Date(filter.from)));
  }
  if (filter.to) {
    conditions.push(lte(tlsApiAuditLogs.createdAt, new Date(filter.to)));
  }
  if (filter.cursor) {
    conditions.push(lt(tlsApiAuditLogs.createdAt, new Date(filter.cursor)));
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

export interface VerifyAuditChainRangeFilter {
  talosId: string;
  /** Inclusive lower bound (ISO-8601 or Date). */
  from?: string | Date;
  /** Inclusive upper bound (ISO-8601 or Date). */
  to?: string | Date;
  /** Maximum entries to verify in the window (default 1000, max 10000). */
  limit?: number;
}

/**
 * Verify the tamper-evident audit hash chain for an agent over an optional
 * `[from, to]` time range.
 *
 * When `from` is specified, also queries the immediate chained predecessor
 * prior to `from` to verify boundary linkage and distinguish an incomplete
 * range (e.g. truncated by `limit` or missing predecessor records) from a
 * cryptographically broken chain.
 */
export async function verifyAuditChainRange(
  filter: VerifyAuditChainRangeFilter,
): Promise<ChainRangeVerificationResult> {
  const limit = Math.min(Math.max(filter.limit ?? 1000, 1), 10000);
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

  if (
    (fromDate !== null && Number.isNaN(fromDate.getTime())) ||
    (toDate !== null && Number.isNaN(toDate.getTime())) ||
    (fromDate !== null && toDate !== null && fromDate.getTime() > toDate.getTime())
  ) {
    return verifyChainRange([], {
      from: fromDate,
      to: toDate,
    });
  }

  const conditions: SQL[] = [
    eq(tlsApiAuditLogs.talosId, filter.talosId),
    isNotNull(tlsApiAuditLogs.entryHash),
  ];

  if (fromDate !== null) {
    conditions.push(gte(tlsApiAuditLogs.createdAt, fromDate));
  }
  if (toDate !== null) {
    conditions.push(lte(tlsApiAuditLogs.createdAt, toDate));
  }

  let predecessor: AuditChainPredecessor | null = null;
  if (fromDate !== null) {
    const predecessorRows = await db
      .select({
        sequenceNumber: tlsApiAuditLogs.sequenceNumber,
        entryHash: tlsApiAuditLogs.entryHash,
        createdAt: tlsApiAuditLogs.createdAt,
      })
      .from(tlsApiAuditLogs)
      .where(
        and(
          eq(tlsApiAuditLogs.talosId, filter.talosId),
          isNotNull(tlsApiAuditLogs.entryHash),
          lt(tlsApiAuditLogs.createdAt, fromDate),
        ),
      )
      .orderBy(desc(tlsApiAuditLogs.createdAt), desc(tlsApiAuditLogs.sequenceNumber))
      .limit(1);

    predecessor = predecessorRows[0] ?? null;
  }

  const rows = await db
    .select({
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
    })
    .from(tlsApiAuditLogs)
    .where(and(...conditions))
    .orderBy(asc(tlsApiAuditLogs.createdAt), asc(tlsApiAuditLogs.sequenceNumber))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const windowRows = truncated ? rows.slice(0, limit) : rows;

  return verifyChainRange(windowRows, {
    predecessor,
    from: fromDate,
    to: toDate,
    truncated,
  });
}
