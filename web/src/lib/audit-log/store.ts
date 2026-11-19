import { and, desc, eq, gte, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
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
