import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { sendUSDC } from "@/lib/stellar";
import { transferSchema, parseBody } from "@/lib/schemas";
import {
  consumeTransferNonce,
  verifyTransferSignature,
  type TransferSignedPayload,
} from "@/lib/transfer-signature";

// POST /api/talos/:id/transfer — Execute a signed USDC transfer on Stellar
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

    const {
      agent,
      destination,
      asset,
      amount,
      nonce,
      expiry,
      signature,
    } = parsed.data;

    // The path is authoritative. Requiring the same agent in the signed body
    // prevents a valid authorization from crossing agent boundaries.
    if (agent !== id) {
      return Response.json(
        { error: "Signed transfer agent does not match the target TALOS" },
        { status: 400 },
      );
    }

    const signedPayload: TransferSignedPayload = {
      agent,
      destination,
      asset,
      amount,
      nonce,
      expiry,
    };

    // Reconstruct and verify the exact canonical payload. No caller-supplied
    // message is accepted, so recipient/asset/amount substitutions invalidate
    // the signature before any transfer is created.
    if (!verifyTransferSignature(signedPayload, auth.talos.apiKey!, signature)) {
      return Response.json(
        { error: "Invalid transfer signature" },
        { status: 403 },
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expirySeconds = Number(expiry);
    if (expirySeconds <= nowSeconds) {
      return Response.json(
        { error: "Transfer authorization has expired" },
        { status: 403 },
      );
    }

    // Check approval threshold before consuming the one-time authorization.
    const talos = await db
      .select({ approvalThreshold: tlsTalos.approvalThreshold })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    const amountValue = Number(amount);
    if (talos && amountValue > Number(talos.approvalThreshold)) {
      return Response.json(
        {
          error: "Amount exceeds approval threshold. Create an approval request first.",
          amount,
          threshold: Number(talos.approvalThreshold),
        },
        { status: 403 },
      );
    }

    // Agent secret key lives server-side only.
    const agentSecret = process.env[`TALOS_AGENT_SECRET_${id}`];
    if (!agentSecret) {
      return Response.json(
        { error: "Agent secret key not configured for this TALOS" },
        { status: 503 },
      );
    }

    // Consume immediately before the first money-moving side effect. The
    // synchronous guard prevents two requests in this process from using the
    // same signed nonce concurrently.
    const nonceResult = consumeTransferNonce(signedPayload, nowSeconds);
    if (!nonceResult.ok) {
      if (nonceResult.reason === "replayed") {
        return Response.json(
          { error: "Transfer authorization already used (replay detected)" },
          { status: 409 },
        );
      }

      return Response.json(
        {
          error:
            nonceResult.reason === "expiry-too-far"
              ? "Transfer authorization expiry exceeds the five-minute limit"
              : "Transfer authorization has expired",
        },
        { status: 403 },
      );
    }

    const result = await sendUSDC(agentSecret, destination, amount);
    return Response.json({
      status: "completed",
      currency: asset,
      to: destination,
      amount,
      txHash: result.txHash,
    });
  } catch (err) {
    console.error("Transfer error:", err);
    return Response.json({ error: "Transfer failed" }, { status: 500 });
  }
}
