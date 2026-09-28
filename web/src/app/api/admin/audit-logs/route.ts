import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { listAuditLogs, parseAuditLogFilters } from "@/lib/audit-log";

/**
 * GET /api/admin/audit-logs — searchable operator view of `tls_api_audit_logs`.
 *
 * Query params:
 *   talosId, method, q (path/denialReason substring), statusCode, statusClass
 *   (2xx|3xx|4xx|5xx), denialReason, from, to, cursor, limit
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>` (same as /api/admin/jobs).
 * Responses never include API keys, request bodies, or other secrets.
 */
export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const parsed = parseAuditLogFilters(searchParams);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const { logs, nextCursor } = await listAuditLogs(parsed.filters);
    return Response.json({ logs, nextCursor, filters: parsed.filters });
  } catch (err) {
    console.error("[admin/audit-logs GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
