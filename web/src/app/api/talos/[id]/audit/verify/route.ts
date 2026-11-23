/**
 * GET /api/talos/:id/audit/verify — Audit log hash chain verification
 *
 * Verifies the integrity of the tamper-evident hash chain for a given agent,
 * optionally restricted to an inclusive `[from, to]` time range.
 *
 * Query parameters:
 *   - from (string, optional): Inclusive ISO-8601 lower time bound.
 *   - to (string, optional): Inclusive ISO-8601 upper time bound.
 *   - limit (number, default 1000): Maximum entries to verify in the window.
 *   - seal (string, optional): HMAC-SHA256 seal to verify against the chain root.
 *
 * Response shape:
 *   200 {
 *     valid, status, complete, incompleteReason, failureReason,
 *     totalEntries, verifiedEntries, brokenAtSequence, chainVersion,
 *     startSequence, endSequence, predecessorSequence, predecessorHash
 *   }
 *   400 { error: "..." }
 *   404 { error: "TALOS not found" }
 *   500 { error: "Internal server error" }
 */

import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApiAuditLogs } from "@/db/schema";
import { eq, and, isNotNull, gte, lte } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import {
  verifyChain,
  sealChainRoot,
  getChainHmacSecret,
} from "@/lib/audit-chain";
import { verifyAuditChainRange } from "@/lib/audit-log/store";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

async function _GET(
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
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    if (fromParam !== null) {
      const fromDate = new Date(fromParam);
      if (Number.isNaN(fromDate.getTime())) {
        return Response.json(
          { error: "from must be a valid ISO-8601 timestamp" },
          { status: 400 },
        );
      }
    }
    if (toParam !== null) {
      const toDate = new Date(toParam);
      if (Number.isNaN(toDate.getTime())) {
        return Response.json(
          { error: "to must be a valid ISO-8601 timestamp" },
          { status: 400 },
        );
      }
    }
    if (
      fromParam !== null &&
      toParam !== null &&
      new Date(fromParam).getTime() > new Date(toParam).getTime()
    ) {
      return Response.json(
        { error: "from must be earlier than or equal to to" },
        { status: 400 },
      );
    }

    if (fromParam !== null || toParam !== null) {
      const result = await verifyAuditChainRange({
        talosId: id,
        from: fromParam ?? undefined,
        to: toParam ?? undefined,
        limit,
      });

      if (sealParam && result.valid && result.verifiedEntries > 0) {
        const hmacSecret = getChainHmacSecret();
        if (!hmacSecret) {
          return Response.json(
            { error: "Audit chain seal verification is not configured" },
            { status: 400 },
          );
        }

        const conditions = [
          eq(tlsApiAuditLogs.talosId, id),
          isNotNull(tlsApiAuditLogs.entryHash),
        ];
        if (fromParam !== null) {
          conditions.push(gte(tlsApiAuditLogs.createdAt, new Date(fromParam)));
        }
        if (toParam !== null) {
          conditions.push(lte(tlsApiAuditLogs.createdAt, new Date(toParam)));
        }

        const rows = await db
          .select({ entryHash: tlsApiAuditLogs.entryHash })
          .from(tlsApiAuditLogs)
          .where(and(...conditions))
          .orderBy(tlsApiAuditLogs.createdAt)
          .limit(limit);

        const lastRow = rows[rows.length - 1];
        if (lastRow?.entryHash) {
          const expectedSeal = sealChainRoot(lastRow.entryHash, hmacSecret);
          if (sealParam !== expectedSeal) {
            result.valid = false;
            result.status = "broken";
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
          status: result.status,
          complete: result.complete,
          totalEntries: result.totalEntries,
          verifiedEntries: result.verifiedEntries,
          brokenAtSequence: result.brokenAtSequence,
        },
        "audit_chain_verified",
      );

      return Response.json(result);
    }

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

export const GET = withRequestId(_GET);
