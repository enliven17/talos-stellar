import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getJob, getJobAttempts } from "@/lib/jobs";

// GET /api/admin/jobs/:id/attempts — immutable attempt history for a job.
async function _GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const job = await getJob(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    const attempts = await getJobAttempts(id);
    return Response.json({ jobId: id, attempts });
  } catch (err) {
    console.error("[admin/jobs/:id/attempts GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRequestId(_GET);