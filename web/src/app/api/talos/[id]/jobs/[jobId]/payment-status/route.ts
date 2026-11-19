/**
 * GET /api/talos/:id/jobs/:jobId/payment-status
 *
 * Returns the Stellar finality status of the payment transaction associated
 * with a commerce job.  Allows contributors and operators to check whether
 * a payment has been confirmed on-chain, failed, expired, or is still pending
 * without needing direct database access.
 *
 * Authentication: none required — job ownership is verified by checking
 * that the job belongs to the requested talosId.  No secret or private data
 * is disclosed in any response path.
 *
 * Response shapes
 * ───────────────
 * 200 — found
 *   {
 *     jobId:          string
 *     txHash:         string
 *     finalityStatus: "PENDING" | "CONFIRMING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "NOT_FOUND"
 *     confirmedLedger: number | null    — set when CONFIRMED
 *     lastLedgerChecked: number | null  — most recent ledger polled
 *     pollCount:      number
 *     lastError:      string | null     — privacy-safe Horizon diagnostic only
 *     repairApplied:  boolean           — true once downstream repair ran
 *     updatedAt:      string            — ISO-8601
 *   }
 *
 * 200 (unregistered) — job exists but the payment was not registered with the
 *   reconciler (e.g. instant-fulfillment jobs, legacy jobs).
 *   { jobId, txHash, finalityStatus: null, registered: false }
 *
 * 404 — job not found or does not belong to this talosId
 * 500 — internal error
 *
 * Privacy contract
 * ────────────────
 * lastError contains only the Horizon result code or a short diagnostic
 * string produced by the reconciler (e.g. "tx_bad_seq",
 * "Ledger gap exceeded: current=1200, submitted=1000, max=120").
 * It never contains wallet private keys, XDR envelopes, payment amounts,
 * buyer identities, or any application payload content.
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsCommerceJobs, tlsStellarTxRecords } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const { id, jobId } = await params;

  try {
    // 1. Verify the job exists and belongs to this talosId
    const job = await db
      .select({
        id: tlsCommerceJobs.id,
        talosId: tlsCommerceJobs.talosId,
        txHash: tlsCommerceJobs.txHash,
        status: tlsCommerceJobs.status,
      })
      .from(tlsCommerceJobs)
      .where(and(eq(tlsCommerceJobs.id, jobId), eq(tlsCommerceJobs.talosId, id)))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    // 2. Look up the reconciler record by sourceType + sourceId
    //    (sourceId is the job id for commerce_job entries)
    const txRecord = await db
      .select({
        id: tlsStellarTxRecords.id,
        txHash: tlsStellarTxRecords.txHash,
        finalityStatus: tlsStellarTxRecords.finalityStatus,
        confirmedLedger: tlsStellarTxRecords.confirmedLedger,
        lastLedgerChecked: tlsStellarTxRecords.lastLedgerChecked,
        pollCount: tlsStellarTxRecords.pollCount,
        lastError: tlsStellarTxRecords.lastError,
        repairApplied: tlsStellarTxRecords.repairApplied,
        updatedAt: tlsStellarTxRecords.updatedAt,
      })
      .from(tlsStellarTxRecords)
      .where(
        and(
          eq(tlsStellarTxRecords.sourceType, "commerce_job"),
          eq(tlsStellarTxRecords.sourceId, jobId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    // 3a. Reconciler record found — return full finality status
    if (txRecord) {
      return Response.json({
        jobId: job.id,
        txHash: txRecord.txHash,
        finalityStatus: txRecord.finalityStatus,
        confirmedLedger: txRecord.confirmedLedger ?? null,
        lastLedgerChecked: txRecord.lastLedgerChecked ?? null,
        pollCount: txRecord.pollCount,
        lastError: txRecord.lastError ?? null,
        repairApplied: txRecord.repairApplied,
        updatedAt: txRecord.updatedAt.toISOString(),
      });
    }

    // 3b. No reconciler record — job pre-dates reconciler integration or was
    //     instant-fulfillment (no async tracking needed).
    return Response.json({
      jobId: job.id,
      txHash: job.txHash ?? null,
      finalityStatus: null,
      registered: false,
    });
  } catch {
    // Intentionally no error detail in response — stack traces and query
    // errors may contain internal schema information.
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
