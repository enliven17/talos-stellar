/**
 * GET /api/talos/:id/audit/checkpoint — Create a chain checkpoint
 *
 * Snapshots the current chain state for an agent:
 *   - The latest entry hash (chain root)
 *   - The total number of chained entries
 *   - An optional HMAC seal of the root
 *
 * This is useful for periodic integrity checks and backup verification.
 *
 * Response shape:
 *   200 { chainRoot, totalEntries, chainVersion, seal?, createdAt }
 *   404 { error: "TALOS not found" }
 *   500 { error: "Internal server error" }
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import { eq, desc, and, isNotNull, count } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import {
  sealChainRoot,
  getChainHmacSecret,
  AUDIT_CHAIN_VERSION,
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

    // Fetch the latest chained entry
    const latestRows = await db
      .select({
        entryHash: tlsApiAuditLogs.entryHash,
        sequenceNumber: tlsApiAuditLogs.sequenceNumber,
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
      .limit(1);

    const latest = latestRows[0] ?? null;

    // Count total chained entries
    const countResult = await db
      .select({ total: count() })
      .from(tlsApiAuditLogs)
      .where(
        and(
          eq(tlsApiAuditLogs.talosId, id),
          isNotNull(tlsApiAuditLogs.entryHash),
        ),
      );

    const totalEntries = countResult[0]?.total ?? 0;

    if (!latest || !latest.entryHash) {
      return Response.json({
        chainRoot: null,
        totalEntries: 0,
        chainVersion: null,
        seal: null,
        createdAt: new Date().toISOString(),
      });
    }

    // Compute optional HMAC seal
    const hmacSecret = getChainHmacSecret();
    const seal = hmacSecret
      ? sealChainRoot(latest.entryHash, hmacSecret)
      : null;

    logger.info(
      {
        talosId: id,
        chainRoot: latest.entryHash,
        totalEntries,
        sealed: seal !== null,
      },
      "audit_chain_checkpoint",
    );

    return Response.json({
      chainRoot: latest.entryHash,
      totalEntries,
      chainVersion: AUDIT_CHAIN_VERSION,
      seal,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "audit_checkpoint_error");
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
