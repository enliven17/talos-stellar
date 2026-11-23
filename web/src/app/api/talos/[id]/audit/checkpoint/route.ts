/**
 * GET /api/talos/:id/audit/checkpoint — Create a chain checkpoint
 *
 * Snapshots the current chain state for an agent:
 *   - The latest entry hash (chain root)
 *   - The total number of chained entries
 *   - An optional HMAC seal of the root
 *   - When `bundle=true` (or sequence/limit parameters are supplied), also
 *     exports an independently verifiable signed checkpoint bundle with
 *     explicit chain boundaries and bounded entries.
 *
 * This is useful for periodic integrity checks and offline backup verification.
 *
 * Response shape:
 *   200 { chainRoot, totalEntries, chainVersion, seal?, createdAt, bundle? }
 *   400 { error: "..." }
 *   404 { error: "TALOS not found" }
 *   500 { error: "Internal server error" }
 */

import { withRequestId } from "@/lib/with-request-id";
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
import { exportAuditCheckpointBundle } from "@/lib/audit-log";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

function parseNonNegativeIntParam(
  raw: string | null,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: `${label} must be a non-negative integer` };
  }
  return { ok: true, value: parseInt(raw.trim(), 10) };
}

async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const url = new URL(request.url);
    const bundleParam = url.searchParams.get("bundle");
    const fromSeqParsed = parseNonNegativeIntParam(
      url.searchParams.get("fromSequence"),
      "fromSequence",
    );
    if (!fromSeqParsed.ok) {
      return Response.json({ error: fromSeqParsed.error }, { status: 400 });
    }
    const toSeqParsed = parseNonNegativeIntParam(
      url.searchParams.get("toSequence"),
      "toSequence",
    );
    if (!toSeqParsed.ok) {
      return Response.json({ error: toSeqParsed.error }, { status: 400 });
    }
    if (
      fromSeqParsed.value !== undefined &&
      toSeqParsed.value !== undefined &&
      fromSeqParsed.value > toSeqParsed.value
    ) {
      return Response.json(
        { error: "fromSequence must be less than or equal to toSequence" },
        { status: 400 },
      );
    }

    const limitRaw = url.searchParams.get("limit");
    let limitValue: number | undefined;
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw.trim()) || parseInt(limitRaw.trim(), 10) === 0) {
        return Response.json(
          { error: "limit must be a positive integer" },
          { status: 400 },
        );
      }
      limitValue = parseInt(limitRaw.trim(), 10);
    }

    const includeBundle =
      bundleParam === "true" ||
      bundleParam === "1" ||
      fromSeqParsed.value !== undefined ||
      toSeqParsed.value !== undefined ||
      limitValue !== undefined;

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
    const nowIso = new Date().toISOString();

    const bundle = includeBundle
      ? await exportAuditCheckpointBundle({
          talosId: id,
          fromSequence: fromSeqParsed.value,
          toSequence: toSeqParsed.value,
          limit: limitValue,
          exportedAt: nowIso,
        })
      : undefined;

    if (!latest || !latest.entryHash) {
      return Response.json({
        chainRoot: null,
        totalEntries: 0,
        chainVersion: null,
        seal: null,
        createdAt: nowIso,
        ...(bundle ? { bundle } : {}),
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
        bundled: Boolean(bundle),
      },
      "audit_chain_checkpoint",
    );

    return Response.json({
      chainRoot: latest.entryHash,
      totalEntries,
      chainVersion: AUDIT_CHAIN_VERSION,
      seal,
      createdAt: nowIso,
      ...(bundle ? { bundle } : {}),
    });
  } catch (err) {
    logger.error({ err }, "audit_checkpoint_error");
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = withRequestId(_GET);
