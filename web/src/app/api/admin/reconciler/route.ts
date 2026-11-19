/**
 * GET  /api/admin/reconciler        — snapshot of in-process reconciler stats
 * POST /api/admin/reconciler/force  — run one reconciler tick synchronously
 *                                     and return a summary
 *
 * Both endpoints require `Authorization: Bearer <ADMIN_API_KEY>`.
 *
 * These endpoints expose operational visibility into the finality reconciler
 * without leaking sensitive data — stats counters and tick summaries contain
 * no txHashes, secrets, or user payload content.
 */

import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getStats } from "@/lib/reconciler";

/**
 * GET /api/admin/reconciler
 *
 * Returns a snapshot of the reconciler's runtime stats:
 *   - Whether the background loop is running
 *   - Counters for confirmed / failed / expired / not_found / errors
 *   - Timing info (startedAt, lastTickAt, lastTickDurationMs)
 *   - In-process queue/active counts
 *
 * Response is safe to log and expose to operators — no secrets, txHashes,
 * wallet keys, or user data are included.
 */
export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const stats = getStats();
  return Response.json({ stats });
}
