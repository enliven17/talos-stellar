/**
 * GET /api/ops/backup/status
 *
 * Read-only view over `tls_backup_runs`. Returns:
 *   - last successful backup run for each (op, scope)
 *   - last failed run (most recent failure)
 *   - the most recent N runs (configurable via ?limit)
 *
 * Auth: same `OPS_ADMIN_SECRET` timing-safe compare as the write endpoints.
 * Rate-limited: 30 calls / minute per IP (status endpoints are chatty).
 *
 * Privacy-safe: no passphrases, no envelope contents, no per-row data.
 */

import { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { tlsBackupRuns } from "@/db/schema";
import { isBackupDisabled, opsAdminSecret } from "@/lib/backup-config";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { withRequestId } from "@/lib/with-request-id";
import { logger } from "@/lib/logger";
import { BackupStatusQuerySchema, sanitizeErrorMessage } from "@/lib/backup-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

async function verifyOpsAdmin(req: NextRequest): Promise<{ ok: true } | { ok: false; error: Response }> {
  const expected = opsAdminSecret();
  if (!expected) {
    return {
      ok: false,
      error: Response.json(
        { error: "Backup status disabled: OPS_ADMIN_SECRET not set" },
        { status: 401 },
      ),
    };
  }
  const supplied = req.headers.get("x-ops-token") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      error: Response.json({ error: "Invalid ops token" }, { status: 401 }),
    };
  }
  return { ok: true };
}

function redactedRun(row: typeof tlsBackupRuns.$inferSelect) {
  return {
    id: row.id,
    op: row.op,
    scope: row.scope,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    talosId: row.talosId,
    agentId: row.agentId,
    triggeredBy: row.triggeredBy,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    sha256: row.sha256,
    encryption: row.encryption,
    errorMessage: row.errorMessage ? sanitizeErrorMessage(row.errorMessage, 160) : null,
    metadata: row.metadata,
  };
}

const rawGet = async (req: NextRequest): Promise<Response> => {
  if (isBackupDisabled()) {
    return Response.json({ error: "Backup is disabled (TALOS_BACKUP_DISABLED=1)" }, { status: 423 });
  }
  const auth = await verifyOpsAdmin(req);
  if (!auth.ok) return auth.error;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rl = rateLimit(`ops:backup-status:${ip}`, RATE_LIMIT);
  if (!rl.ok) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const q = BackupStatusQuerySchema.safeParse({
    scope: url.searchParams.get("scope") ?? undefined,
    op: url.searchParams.get("op") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!q.success) {
    return Response.json(
      { error: "Validation failed", issues: q.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const { scope, op, limit } = q.data;

  const where = and(
    scope ? eq(tlsBackupRuns.scope, scope) : undefined,
    op ? eq(tlsBackupRuns.op, op) : undefined,
  );

  try {
    const recent = await db
      .select()
      .from(tlsBackupRuns)
      .where(where)
      .orderBy(desc(tlsBackupRuns.startedAt))
      .limit(limit);
    const lastSuccess = await db
      .select()
      .from(tlsBackupRuns)
      .where(and(where, eq(tlsBackupRuns.status, "completed")))
      .orderBy(desc(tlsBackupRuns.startedAt))
      .limit(1);
    const lastFailure = await db
      .select()
      .from(tlsBackupRuns)
      .where(and(where, eq(tlsBackupRuns.status, "failed")))
      .orderBy(desc(tlsBackupRuns.startedAt))
      .limit(1);
    const totalsRow = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        successes: sql<number>`COUNT(*) FILTER (WHERE ${tlsBackupRuns.status} = 'completed')::int`,
        failures: sql<number>`COUNT(*) FILTER (WHERE ${tlsBackupRuns.status} = 'failed')::int`,
      })
      .from(tlsBackupRuns)
      .where(where);
    const totals = totalsRow[0] ?? { total: 0, successes: 0, failures: 0 };

    return Response.json({
      ok: true,
      metrics: {
        total: Number(totals.total),
        successes: Number(totals.successes),
        failures: Number(totals.failures),
        lastSuccess: lastSuccess[0] ? redactedRun(lastSuccess[0]) : null,
        lastFailure: lastFailure[0] ? redactedRun(lastFailure[0]) : null,
      },
      recent: recent.map(redactedRun),
    });
  } catch (err) {
    logger.error(
      { err: sanitizeErrorMessage(err), requestId: req.headers.get("x-request-id") ?? null },
      "ops backup status failed",
    );
    return Response.json(
      { error: "Failed to read backup status", details: sanitizeErrorMessage(err) },
      { status: 500 },
    );
  }
};

export const GET = withRequestId(rawGet);
