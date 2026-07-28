/**
 * GET /api/talos/:id/audit/verify — Audit log hash chain verification
 *
 * Verifies the integrity of the tamper-evident hash chain for a given agent.
 *
 * Query parameters:
 *   - limit (number, default 1000): Maximum entries to verify from the tail.
 *   - seal (string, optional): HMAC-SHA256 seal to verify against the chain root.
 *
 * Response shape:
 *   200 { valid, totalEntries, verifiedEntries, brokenAtSequence, chainVersion }
 *   404 { error: "TALOS not found" }
 *   500 { error: "Internal server error" }
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import {
  verifyChain,
  sealChainRoot,
  getChainHmacSecret,
} from "@/lib/audit-chain";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = Math.min(Math.max(Number(limitParam) || 1000, 1), 10000);
    const sealParam = url.searchParams.get("seal");

    // Fetch all chained entries for this agent, ordered by createdAt
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
      .where(
        and(
          eq(tlsApiAuditLogs.talosId, id),
          isNotNull(tlsApiAuditLogs.entryHash),
        ),
      )
      .orderBy(tlsApiAuditLogs.createdAt)
      .limit(limit);

    const result = verifyChain(rows);

    // Optional HMAC seal verification
    if (sealParam && result.valid && result.verifiedEntries > 0) {
      const hmacSecret = getChainHmacSecret();
      if (!hmacSecret) {
        return Response.json(
          { error: "Audit chain seal verification is not configured" },
          { status: 400 },
        );
      }

      const lastRow = rows[rows.length - 1];
      if (lastRow.entryHash) {
        const expectedSeal = sealChainRoot(lastRow.entryHash, hmacSecret);
        if (sealParam !== expectedSeal) {
          result.valid = false;
          logger.warn(
            { talosId: id, expectedSeal, providedSeal: sealParam },
            "audit_chain_seal_mismatch",
          );
        }
      }
    }

    logger.info(
      {
        talosId: id,
        valid: result.valid,
        totalEntries: result.totalEntries,
        verifiedEntries: result.verifiedEntries,
        brokenAtSequence: result.brokenAtSequence,
      },
      "audit_chain_verified",
    );

    return Response.json(result);
  } catch (err) {
    logger.error({ err }, "audit_verify_error");
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
