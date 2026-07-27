import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { listJobs } from "@/lib/jobs";
import type { JobStatus } from "@/lib/jobs";

const VALID_STATUSES: JobStatus[] = ["pending", "leased", "completed", "dead_letter", "cancelled"];

// GET /api/admin/jobs — list/inspect jobs. Filter by status and/or queue,
// cursor-paginated by createdAt descending (same convention as the other
// list endpoints in this API — see OBSERVABILITY.md § Pagination).
export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    if (statusParam && !VALID_STATUSES.includes(statusParam as JobStatus)) {
      return Response.json(
        { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }

    const { jobs, nextCursor } = await listJobs({
      status: (statusParam as JobStatus) ?? undefined,
      queue: searchParams.get("queue") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined,
    });

    return Response.json({ jobs, nextCursor });
  } catch (err) {
    console.error("[admin/jobs GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
