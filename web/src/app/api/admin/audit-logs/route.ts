import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import {
  AUDIT_EXPORT_FORMATS,
  type AuditExportFormat,
} from "@/lib/audit-chain";
import {
  exportAuditLogs,
  listAuditLogs,
  parseAuditLogFilters,
} from "@/lib/audit-log";

/**
 * GET /api/admin/audit-logs — searchable operator view of `tls_api_audit_logs`.
 *
 * Query params:
 *   talosId, method, q (path/denialReason substring), statusCode, statusClass
 *   (2xx|3xx|4xx|5xx), denialReason, from, to, cursor, limit, format (csv|json)
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>` (same as /api/admin/jobs).
 * Responses never include API keys, request bodies, or other secrets.
 */
async function _GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const formatParam = searchParams.get("format");
    if (
      formatParam !== null &&
      !AUDIT_EXPORT_FORMATS.includes(formatParam as AuditExportFormat)
    ) {
      return Response.json(
        { error: `Invalid format. Must be one of: ${AUDIT_EXPORT_FORMATS.join(", ")}` },
        { status: 400 },
      );
    }

    const parsed = parseAuditLogFilters(searchParams);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const { logs, nextCursor } = await listAuditLogs(parsed.filters);

    if (formatParam !== null) {
      const exported = await exportAuditLogs(parsed.filters, {
        format: formatParam as AuditExportFormat,
        logs,
        nextCursor,
      });
      return new Response(exported.data, {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": exported.contentDisposition,
          "Content-Type": exported.contentType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    return Response.json({ logs, nextCursor, filters: parsed.filters });
  } catch (err) {
    console.error("[admin/audit-logs GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);
