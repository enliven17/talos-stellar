import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { withTraceContext } from "@/lib/tracing";

// GET /api/talos/:id/wallet — Agent fetches its Stellar wallet info at startup
async function handleGet(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["wallet:read"]);
    if (!auth.ok) return auth.response;

    const talos = await db
      .select({
        agentWalletId: tlsTalos.agentWalletId,
        agentWalletAddress: tlsTalos.agentWalletAddress,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos?.agentWalletId) {
      return Response.json({ error: "No agent wallet for this TALOS" }, { status: 404 });
    }

    return Response.json({
      agentWalletId: talos.agentWalletId,
      agentWalletAddress: talos.agentWalletAddress,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
