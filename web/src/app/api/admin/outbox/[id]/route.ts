import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { getEvent } from "@/lib/outbox";

// GET /api/admin/outbox/:id — full record for one event (payload, lease
// state, attempt history) for debugging a stuck or dead-lettered event.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    const event = await getEvent(id);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
    return Response.json(event);
  } catch (err) {
    console.error("[admin/outbox/:id GET]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
