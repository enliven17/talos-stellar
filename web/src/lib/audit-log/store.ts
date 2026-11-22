import { and, count, desc, eq, gte, isNotNull, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
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
