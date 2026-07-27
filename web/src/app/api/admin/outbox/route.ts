import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { listEvents } from "@/lib/outbox";
import type { OutboxStatus } from "@/lib/outbox";

const VALID_STATUSES: OutboxStatus[] = ["pending", "leased", "dispatched", "dead_letter"];

// GET /api/admin/outbox — list/inspect outbox events. Filter by status
// and/or eventType, cursor-paginated by createdAt descending (same
// convention as the rest of the API — see OBSERVABILITY.md § Pagination).
export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    if (statusParam && !VALID_STATUSES.includes(statusParam as OutboxStatus)) {
      return Response.json(
        { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }

    const { events, nextCursor } = await listEvents({
      status: (statusParam as OutboxStatus) ?? undefined,
      eventType: searchParams.get("eventType") ?? undefined,
      cursor: searchParams.get("cursor") ?? undefined,
      limit: searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined,
    });

    return Response.json({ events, nextCursor });
  } catch (err) {
    console.error("[admin/outbox GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
