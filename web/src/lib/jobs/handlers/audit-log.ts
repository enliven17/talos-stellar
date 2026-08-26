import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import { registerHandler } from "../registry";

/**
 * Durable version of the API-key audit log write. See src/lib/auth.ts —
 * when JOBS_ENABLED=true, `writeAuditLog()` enqueues onto this queue instead
 * of inserting directly, so a transient DB error no longer silently drops
 * an audit entry (the previous behavior was fire-and-forget with `.catch(()
 * => {})`). Payload carries only identifiers already present in the
 * existing tls_api_audit_logs row — no request bodies or secrets.
 */
export const AUDIT_LOG_WRITE_QUEUE = "audit_log_write";

export interface AuditLogWritePayload {
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  ipAddress: string | null;
  denialReason?: string | null;
  scopesRequired?: string[] | null;
}

registerHandler<AuditLogWritePayload, { inserted: true }>(AUDIT_LOG_WRITE_QUEUE, async (ctx) => {
  await db.insert(tlsApiAuditLogs).values({
    talosId: ctx.payload.talosId,
    method: ctx.payload.method,
    path: ctx.payload.path,
    statusCode: ctx.payload.statusCode,
    ipAddress: ctx.payload.ipAddress,
    denialReason: ctx.payload.denialReason ?? null,
    scopesRequired: ctx.payload.scopesRequired ?? null,
  });
  return { inserted: true };
});
