import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsActivities } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/activity — Get activities
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const talos = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const activities = await db
      .select()
      .from(tlsActivities)
      .where(eq(tlsActivities.talosId, id))
      .orderBy(desc(tlsActivities.createdAt))
      .limit(50);

    return Response.json(activities);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/activity — Report activity (from Local Agent)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { type, content, channel, status } = body;

    const validTypes = ["post", "research", "reply", "commerce", "approval"];
    const validStatuses = ["completed", "pending", "failed"];

    if (!type || !content || !channel) {
      return Response.json(
        { error: "type, content, channel are required" },
        { status: 400 }
      );
    }

    if (!validTypes.includes(type)) {
      return Response.json(
        { error: `type must be one of: ${validTypes.join(", ")}` },
        { status: 400 }
      );
    }

    if (status && !validStatuses.includes(status)) {
      return Response.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    const [activity] = await db
      .insert(tlsActivities)
      .values({
        talosId: id,
        type,
        content,
        channel,
        status: status ?? "completed",
      })
      .returning();

    return Response.json(activity, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
