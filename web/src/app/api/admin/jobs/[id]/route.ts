import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getJob } from "@/lib/jobs";

// GET /api/admin/jobs/:id — full record for one job (payload, result, lease
// state, attempt history) for debugging a stuck or dead-lettered job.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const job = await getJob(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json(job);
  } catch (err) {
    console.error("[admin/jobs/:id GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
