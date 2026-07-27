import { NextRequest } from "next/server";
import { verifyInternalJobsSecret } from "@/lib/admin-auth";
import { jobsConfig, runOnce } from "@/lib/jobs";
// Side-effect import: registers every job handler. Required here (and only
// here / in the worker script) because this route actually executes jobs —
// enqueue-only call sites don't need the handler registry populated.
import "@/lib/jobs/handlers";

/**
 * POST /api/internal/jobs/drain
 *
 * Leases and processes one bounded batch of due jobs, then returns. Meant
 * to be hit on an interval by an external scheduler (Vercel Cron, a Railway
 * cron service, GitHub Actions schedule, etc.) — Next.js API routes on
 * Vercel are serverless functions with no persistent process, so a
 * continuously-polling worker isn't available there; this endpoint is the
 * serverless-compatible alternative. For a long-lived deployment (e.g. the
 * Railway service already used for the Python agent), scripts/jobs-worker.ts
 * runs the same runOnce() batch in a continuous loop instead.
 *
 * A no-op (200, processed:0) when JOBS_ENABLED is false — the queue exists
 * but nothing drains it until an operator opts in, so wiring this endpoint
 * into a scheduler ahead of enabling the flag is safe.
 */
export async function POST(request: NextRequest) {
  const auth = verifyInternalJobsSecret(request);
  if (!auth.ok) return auth.response;

  if (!jobsConfig.enabled) {
    return Response.json({ enabled: false, summary: null });
  }

  try {
    const summary = await runOnce();
    return Response.json({ enabled: true, summary });
  } catch (err) {
    console.error("[internal/jobs/drain POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
