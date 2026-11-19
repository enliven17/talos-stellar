/**
 * POST /api/admin/reconciler/force
 *
 * Triggers one synchronous reconciler tick and returns a summary of what
 * happened.  Useful for operators who want to force reconciliation without
 * waiting for the next scheduled interval, or for integration tests that
 * need deterministic execution.
 *
 * Requires `Authorization: Bearer <ADMIN_API_KEY>`.
 *
 * Response (200):
 *   {
 *     processed:      number   — total tx records evaluated this tick
 *     confirmed:      number   — transitions to CONFIRMED
 *     failed:         number   — transitions to FAILED
 *     expired:        number   — transitions to EXPIRED
 *     notFound:       number   — transitions to NOT_FOUND
 *     repairsApplied: number   — downstream repair ops applied
 *     errors:         number   — transient Horizon/DB errors
 *     currentLedger:  number | null — Horizon ledger at tick time
 *   }
 *
 * Response (503):
 *   If Horizon is unreachable (currentLedger === null) the tick still runs
 *   but returns a 503 with the partial summary so the caller can distinguish
 *   a connectivity problem from a genuine "nothing to do" response.
 *
 * Errors are explicit and privacy-safe: no txHashes, wallet keys, payment
 * proofs, or user payload content appear in any response body.
 */

import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { runOneTick } from "@/lib/reconciler";

export async function POST(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const summary = await runOneTick();

    // 503 when Horizon was unreachable so the caller can distinguish
    // "connectivity problem" from "nothing pending".
    if (summary.currentLedger === null) {
      return Response.json(
        { error: "Horizon unreachable — tick ran with no ledger data", summary },
        { status: 503 },
      );
    }

    return Response.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    // Do not echo the raw error object — it may contain internal paths or
    // configuration fragments.  A generic message is sufficient for ops.
    return Response.json({ error: message }, { status: 500 });
  }
}
