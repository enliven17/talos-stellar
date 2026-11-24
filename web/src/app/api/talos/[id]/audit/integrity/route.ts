/**
 * GET /api/talos/:id/audit/integrity
 *
 * Returns a bounded audit integrity readiness report for the given agent.
 * Samples the last AUDIT_INTEGRITY_SAMPLE_SIZE entries, verifies their hash
 * chain, and checks the age of the most recent checkpoint — all in a single
 * read-only pass with no full-history scan.
 *
 * Chain breaks and stale checkpoints are reported as separate status codes
 * so operators can distinguish tampering from a lapsed checkpoint job.
 *
 * Response shapes
 * ───────────────
 *   200  AuditIntegrityReport
 *   404  { error: "TALOS not found" }
 *   500  { error: "Internal server error" }
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsApiAuditLogs } from "@/db/schema";
import { and, eq, isNotNull, desc } from "drizzle-orm";
import { verifyChain } from "@/lib/audit-chain";
import {
  buildAuditIntegrityReport,
  AUDIT_INTEGRITY_SAMPLE_SIZE,
} from "@/lib/audit-log/integrity";
import { withTraceContext } from "@/lib/tracing";

async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // 1. Confirm the agent exists.
    const agent = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // 2. Fetch the most recent AUDIT_INTEGRITY_SAMPLE_SIZE chained entries
    //    (newest first so we get the tail of the chain), then reverse for
    //    sequential verification.
    const rawRows = await db
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
      .where(
        and(
          eq(tlsApiAuditLogs.talosId, id),
          isNotNull(tlsApiAuditLogs.entryHash),
        ),
      )
      .orderBy(desc(tlsApiAuditLogs.createdAt))
      .limit(AUDIT_INTEGRITY_SAMPLE_SIZE);

    // Reverse so verifyChain sees entries in ascending (oldest-first) order.
    const rows = [...rawRows].reverse();

    const chainResult = verifyChain(rows);

    const lastVerifiedAt =
      rows.length > 0
        ? rows[rows.length - 1].createdAt.toISOString()
        : null;

    // 3. Fetch the most recent checkpoint timestamp (latest entry with an
    //    entryHash — same as what the checkpoint route captures).
    const checkpointRows = await db
      .select({ createdAt: tlsApiAuditLogs.createdAt })
      .from(tlsApiAuditLogs)
      .where(
        and(
          eq(tlsApiAuditLogs.talosId, id),
          isNotNull(tlsApiAuditLogs.entryHash),
        ),
      )
      .orderBy(desc(tlsApiAuditLogs.createdAt))
      .limit(1);

    const lastCheckpointAt =
      checkpointRows.length > 0
        ? checkpointRows[0].createdAt.toISOString()
        : null;

    // 4. Build and return the report.
    const report = buildAuditIntegrityReport({
      chainResult,
      sampledEntries: rows.length,
      lastVerifiedAt,
      lastCheckpointAt,
      now: new Date(),
    });

    return Response.json(report);
  } catch (err) {
    console.error("Error building audit integrity report:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
