import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { signX402Payment } from "@/lib/stellar-x402";
import { signPaymentSchema, parseBody } from "@/lib/schemas";

// POST /api/talos/:id/sign — Signing proxy for Stellar x402 payments
// Agent sends payment details, Web signs via Stellar ED25519, returns payment token
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // 1. Authenticate agent
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    // 2. Get TALOS wallet info
    const talos = await db
      .select({
        agentWalletId: tlsTalos.agentWalletId,
        agentWalletAddress: tlsTalos.agentWalletAddress,
        approvalThreshold: tlsTalos.approvalThreshold,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos?.agentWalletAddress) {
      return Response.json({ error: "No agent wallet for this TALOS" }, { status: 404 });
    }

    // 3. Parse & validate request
    const parsed = await parseBody(request, signPaymentSchema);
    if (parsed.error) return parsed.error;

    const { payee, amount, assetCode } = parsed.data;
    const amountStr = typeof amount === "number" ? String(amount) : amount;
    const amountUsd = Number(amountStr);

    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return Response.json({ error: "amount must be a positive number" }, { status: 400 });
    }

    // 4. Check against Kernel approval threshold
    const threshold = Number(talos.approvalThreshold);
    if (amountUsd > threshold) {
      return Response.json(
        {
          error: "Amount exceeds approval threshold",
          amountUsd,
          threshold,
          message: "Create an approval request first",
        },
        { status: 403 }
      );
    }

    // 5. Load agent secret key from server-side env
    const agentSecret = process.env[`TALOS_AGENT_SECRET_${id}`];
    if (!agentSecret) {
      return Response.json(
        { error: "Agent secret key not configured for this TALOS" },
        { status: 503 }
      );
    }

    // 6. Sign x402 payment via Stellar
    const { paymentToken } = await signX402Payment(agentSecret, {
      from: talos.agentWalletAddress,
      to: payee,
      amount: amountStr,
      assetCode: assetCode ?? "USDC",
    });

    // 7. Return X-Payment header value + metadata
    return Response.json({
      paymentHeader: `x402 ${paymentToken}`,
      paymentToken,
      from: talos.agentWalletAddress,
      to: payee,
      amount: amountStr,
      assetCode: assetCode ?? "USDC",
    });
  } catch (err) {
    console.error("Signing error:", err);
    return Response.json({ error: "Signing failed" }, { status: 500 });
  }
}
