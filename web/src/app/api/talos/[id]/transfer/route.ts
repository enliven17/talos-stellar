import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { sendUSDC } from "@/lib/stellar";
import { transferSchema, parseBody } from "@/lib/schemas";

// POST /api/talos/:id/transfer — Execute USDC transfer on Stellar
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request, transferSchema);
    if (parsed.error) return parsed.error;

    const { to, amount } = parsed.data;

    // Check approval threshold
    const talos = await db
      .select({ approvalThreshold: tlsTalos.approvalThreshold })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (talos && amount > Number(talos.approvalThreshold)) {
      return Response.json(
        {
          error: "Amount exceeds approval threshold. Create an approval request first.",
          amount,
          threshold: Number(talos.approvalThreshold),
        },
        { status: 403 }
      );
    }

    // Agent secret key lives server-side only
    const agentSecret = process.env[`TALOS_AGENT_SECRET_${id}`];
    if (!agentSecret) {
      return Response.json(
        { error: "Agent secret key not configured for this TALOS" },
        { status: 503 }
      );
    }

    const result = await sendUSDC(agentSecret, to, String(amount));
    return Response.json({
      status: "completed",
      currency: "USDC",
      to,
      amount,
      txHash: result.txHash,
    });
  } catch (err) {
    console.error("Transfer error:", err);
    return Response.json({ error: "Transfer failed" }, { status: 500 });
  }
}
