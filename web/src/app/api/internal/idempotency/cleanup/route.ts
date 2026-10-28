import { NextRequest } from "next/server";
import { verifyInternalSecret } from "@/lib/admin-auth";
import { cleanupExpiredIdempotencyKeys, idempotencyConfig } from "@/lib/idempotency";
import { logger } from "@/lib/logger";

/**
 * POST /api/internal/idempotency/cleanup
 *
 * Removes one bounded batch of completed commerce-job idempotency records
 * whose retention window has elapsed, then returns a structured summary.
 * Meant to be hit on an interval by an external scheduler (Vercel Cron, a
 * Railway cron service, GitHub Actions schedule, etc.) — see
 * `web/docs/LOAD_TESTING.md` for the same operating model used by the jobs
 * and outbox drain endpoints.
 *
 * Safe to re-run: every run deletes at most
 * `IDEMPOTENCY_CLEANUP_BATCH_SIZE` rows (hard-capped at 5,000), only rows in
 * the terminal "completed" state are ever eligible, and a run with nothing to
 * do is a cheap no-op. Operators can pass `?limit=<n>` to bound a manual run
 * further; a malformed limit is rejected with 400.
 *
 * Auth: `x-internal-idempotency-secret: <INTERNAL_IDEMPOTENCY_SECRET>`.
 *
 * Degraded responses stay 2xx so a scheduler keeps retrying rather than
 * paging: `table_missing` / `column_missing` mean the database is not
 * provisioned for this ledger yet, and the summary carries the reason.
 */
export async function POST(request: NextRequest) {
  const auth = verifyInternalSecret(
    request,
    "INTERNAL_IDEMPOTENCY_SECRET",
    "x-internal-idempotency-secret",
  );
  if (!auth.ok) return auth.response;

  const limitParam = request.nextUrl.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
    limit = parsed;
  }

  const result = await cleanupExpiredIdempotencyKeys({ limit });

  if (result.code === "invalid_options") {
    return Response.json(result, { status: 400 });
  }

  if (result.code === "table_missing" || result.code === "column_missing") {
    // Not an application error — the ledger is not provisioned. Report the
    // degradation without a 5xx so scheduler alerting stays meaningful.
    return Response.json(result, { status: 200 });
  }

  if (!result.ok) {
    logger.warn(
      { event: "idempotency_cleanup_failed", code: result.code, limit: result.limit },
      "completed idempotency key cleanup failed",
    );
    return Response.json(result, { status: 500 });
  }

  if (result.deleted > 0) {
    // Counts only — never key values, payloads, or response bodies.
    logger.info(
      {
        event: "idempotency_cleanup_run",
        deleted: result.deleted,
        examined: result.examined,
        skipped: result.skipped,
        hasMore: result.hasMore,
        limit: result.limit,
      },
      "expired completed idempotency keys pruned",
    );
  }

  return Response.json({ ...result, retentionMs: idempotencyConfig.retentionMs });
}
