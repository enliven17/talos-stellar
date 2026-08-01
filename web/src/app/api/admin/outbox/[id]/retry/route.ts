import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getEvent, requeue } from "@/lib/outbox";

// POST /api/admin/outbox/:id/retry — requeue a dead_letter event: resets
// attempts to 0, clears lastError, sets runAt to now. 409 if the event
// isn't in dead_letter (only terminal-failure state is eligible, so this
// can't be used to re-dispatch an event that already succeeded).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const requeued = await requeue(id);
    if (requeued) return Response.json(requeued);

    const existing = await getEvent(id);
    if (!existing) return Response.json({ error: "Event not found" }, { status: 404 });
    return Response.json({ error: `Event is not retryable (status=${existing.status})` }, { status: 409 });
  } catch (err) {
    console.error("[admin/outbox/:id/retry POST]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
