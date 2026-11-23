/**
 * GET /api/talos/:id/retirement-readiness
 *
 * Returns a read-only retirement readiness report for the given agent.
 * Checks pending commerce jobs, unsettled payments, and undistributed
 * revenue so the caller can decide whether retirement is safe before
 * submitting the retire action.
 *
 * This endpoint performs no mutations and never advances the lifecycle
 * state — it is safe to poll repeatedly.
 *
 * Response shapes
 * ───────────────
 *   200  RetirementReadinessReport
 *   404  { error: "TALOS not found" }
 *   409  { error: "...", code: "LIFECYCLE_TERMINAL_STATE" }  — already retired
 *   500  { error: "Internal server error" }
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs, tlsRevenues, tlsDividends } from "@/db/schema";
import { and, eq, not, inArray, sql } from "drizzle-orm";
import { withTraceContext } from "@/lib/tracing";
import { buildRetirementReadinessReport } from "@/lib/governance/retirement-readiness";

const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // 1. Verify the agent exists and is not already retired.
    const agent = await db
      .select({ id: tlsTalos.id, retiredAt: tlsTalos.retiredAt })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    if (agent.retiredAt) {
      return Response.json(
        {
          error: "Agent is retired; no further lifecycle transitions are possible",
          code: "LIFECYCLE_TERMINAL_STATE",
        },
        { status: 409 },
      );
    }

    // 2. Count commerce jobs that are not in a terminal state.
    const [pendingJobsRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, id),
          not(inArray(tlsCommerceJobs.status, [...TERMINAL_JOB_STATUSES])),
        ),
      );

    const pendingJobs = pendingJobsRow?.count ?? 0;

    // 3. Count jobs specifically in "pending" status (payment not yet settled).
    const [pendingPaymentsRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(tlsCommerceJobs)
      .where(
        and(eq(tlsCommerceJobs.talosId, id), eq(tlsCommerceJobs.status, "pending")),
      );

    const pendingPayments = pendingPaymentsRow?.count ?? 0;

    // 4. Net undistributed revenue = sum(revenues) − sum(completed dividends).
    const [revenueRow] = await db
      .select({ total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')` })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id));

    const [dividendRow] = await db
      .select({ total: sql<string>`coalesce(sum(${tlsDividends.amount}), '0')` })
      .from(tlsDividends)
      .where(
        and(eq(tlsDividends.talosId, id), eq(tlsDividends.status, "completed")),
      );

    const totalRevenue = Number(revenueRow?.total ?? "0");
    const totalDistributed = Number(dividendRow?.total ?? "0");
    const undistributedRevenueUSDC = Math.max(0, totalRevenue - totalDistributed);

    // 5. Build and return the report.
    const report = buildRetirementReadinessReport({
      agentId: id,
      currentState: "active",
      pendingJobs,
      pendingPayments,
      undistributedRevenueUSDC,
    });

    return Response.json(report);
  } catch (err) {
    console.error("Error building retirement readiness report:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
