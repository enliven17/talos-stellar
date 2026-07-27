import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getJob, requeue } from "@/lib/jobs";

// POST /api/admin/jobs/:id/retry — requeue a dead_letter or cancelled job:
// resets attempts to 0, clears lastError, sets runAt to now. No-op error
// (409) if the job is pending/leased/completed — only terminal-failure
// states are eligible, so this can't be used to double-run a completed job.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const requeued = await requeue(id);
    if (requeued) return Response.json(requeued);

    const existing = await getJob(id);
    if (!existing) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json(
      { error: `Job is not in a retryable state (status=${existing.status})` },
      { status: 409 },
    );
  } catch (err) {
    console.error("[admin/jobs/:id/retry POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
