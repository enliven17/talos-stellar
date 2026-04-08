import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// PATCH /api/talos/:id/status — Agent status update (online/offline)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { agentOnline } = body;

    if (typeof agentOnline !== "boolean") {
      return Response.json(
        { error: "agentOnline must be a boolean" },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(tlsTalos)
      .set({
        agentOnline,
        agentLastSeen: new Date(),
      })
      .where(eq(tlsTalos.id, id))
      .returning();

    return Response.json({
      id: updated.id,
      agentOnline: updated.agentOnline,
      agentLastSeen: updated.agentLastSeen,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
