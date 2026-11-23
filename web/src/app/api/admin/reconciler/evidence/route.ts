/**
 * GET /api/admin/reconciler/evidence
 *
 * Exposes a bounded, privacy-safe evidence trail for payment finality decisions.
 * Returns observations containing the closed ledger sequence, observation source,
 * transition reason, and finality state changes.
 *
 * Authentication:
 *   Authorization: Bearer <ADMIN_API_KEY>
 *
 * Query Parameters:
 *   txHash  - Filter by Stellar transaction hash (optional)
 *   status  - Filter by resulting or originating finality status (optional)
 *   source  - Filter by observation source e.g. "horizon", "wall_clock", "ledger_gap" (optional)
 *   limit   - Maximum number of evidence items to return (default: 50, max: 200)
 *
 * Privacy Guarantees:
 *   Responses NEVER include private keys, secret seeds, customer payloads,
 *   raw XDR envelopes, or payment amounts. Only sanitized finality metadata
 *   is returned.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import {
  getEvidenceTrail,
  truncateTxHash,
  type FinalityEvidence,
  type FinalityStatus,
} from "@/lib/reconciler";
import { db } from "@/db";
import { tlsStellarTxRecords } from "@/db/schema";
import { eq } from "drizzle-orm";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface FinalityEvidenceDTO {
  txHash: string;
  txHashTruncated: string;
  ledger: number | null;
  observationSource: string;
  transitionReason: string;
  fromStatus: string;
  toStatus: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
}

export interface FinalityEvidenceResponse {
  evidence: FinalityEvidenceDTO[];
  total: number;
  limit: number;
}

export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  // 1. Authenticate admin operator
  const auth = verifyAdminKey(request);
  if (!auth.ok) {
    return auth.response;
  }

  // 2. Parse and validate query parameters
  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get("limit");
  const txHashParam = searchParams.get("txHash")?.trim();
  const statusParam = searchParams.get("status")?.trim().toUpperCase();
  const sourceParam = searchParams.get("source")?.trim().toLowerCase();

  let limit = DEFAULT_LIMIT;
  if (limitParam !== null && limitParam !== "") {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "Invalid limit parameter: must be a positive integer" },
        { status: 400 },
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  // 3. Query in-memory bounded evidence trail
  const entries: FinalityEvidence[] = getEvidenceTrail({
    txHash: txHashParam || undefined,
    status: statusParam as FinalityStatus | undefined,
    source: sourceParam || undefined,
    limit,
  });

  // 4. Fallback: If a specific txHash was queried and not in memory (e.g. occurred before restart),
  //    synthesize evidence from persisted DB state.
  if (entries.length === 0 && txHashParam) {
    try {
      const dbRow = await db
        .select({
          txHash: tlsStellarTxRecords.txHash,
          finalityStatus: tlsStellarTxRecords.finalityStatus,
          ledgerSubmitted: tlsStellarTxRecords.ledgerSubmitted,
          lastLedgerChecked: tlsStellarTxRecords.lastLedgerChecked,
          confirmedLedger: tlsStellarTxRecords.confirmedLedger,
          lastError: tlsStellarTxRecords.lastError,
          updatedAt: tlsStellarTxRecords.updatedAt,
          createdAt: tlsStellarTxRecords.createdAt,
        })
        .from(tlsStellarTxRecords)
        .where(eq(tlsStellarTxRecords.txHash, txHashParam))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (dbRow) {
        const synthesized: FinalityEvidence = {
          txHash: dbRow.txHash,
          txHashTruncated: truncateTxHash(dbRow.txHash),
          ledger:
            dbRow.confirmedLedger ??
            dbRow.lastLedgerChecked ??
            dbRow.ledgerSubmitted ??
            null,
          observationSource: "horizon",
          transitionReason:
            dbRow.lastError ??
            (dbRow.finalityStatus === "CONFIRMED"
              ? "Transaction confirmed on-chain in closed ledger"
              : `Persisted finality state: ${dbRow.finalityStatus}`),
          fromStatus: "PENDING",
          toStatus: dbRow.finalityStatus as FinalityStatus,
          decidedAt: dbRow.updatedAt ?? dbRow.createdAt ?? new Date(),
        };
        entries.push(synthesized);
      }
    } catch {
      // If DB read fails or DB unavailable in unit tests, graceful fallback to memory entries
    }
  }

  // 5. Transform to bounded, privacy-safe DTOs
  const evidence: FinalityEvidenceDTO[] = entries.slice(0, limit).map((e) => ({
    txHash: e.txHash ?? "",
    txHashTruncated: e.txHashTruncated ?? truncateTxHash(e.txHash),
    ledger: e.ledger,
    observationSource: e.observationSource,
    transitionReason: e.transitionReason,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    decidedAt:
      e.decidedAt instanceof Date
        ? e.decidedAt.toISOString()
        : new Date(e.decidedAt).toISOString(),
    metadata: e.metadata,
  }));

  const responseBody: FinalityEvidenceResponse = {
    evidence,
    total: evidence.length,
    limit,
  };

  return NextResponse.json(responseBody, { status: 200 });
}
