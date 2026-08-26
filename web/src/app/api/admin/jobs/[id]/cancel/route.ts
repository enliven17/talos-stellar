import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getJob, requestCancel } from "@/lib/jobs";

// POST /api/admin/jobs/:id/cancel — cooperative cancellation. A pending job
// is cancelled immediately; a leased (in-flight) job is flagged and stops
// on its next heartbeat() call inside the handler — cancellation of running
// work is best-effort, not instant, since we don't kill handler code.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const cancelled = await requestCancel(id);
    if (cancelled) return Response.json(cancelled);

    const existing = await getJob(id);
    if (!existing) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json(
      { error: `Job is not cancellable (status=${existing.status})` },
      { status: 409 },
    );
  } catch (err) {
    console.error("[admin/jobs/:id/cancel POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
