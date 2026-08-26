import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { retireAgentSchema, parseBody } from "@/lib/schemas";

// POST /api/talos/:id/retire - Retire an agent (preserves history, prevents reuse)
// Requires Stellar ED25519 signature proof of wallet ownership.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const parsed = await parseBody(request, retireAgentSchema);
    if (parsed.error) return parsed.error;

    const { reason, supersededBy, stellarPublicKey, signature, message } = parsed.data;

    // Verify the message contains the TALOS ID to prevent replay across TALOSes
    if (!message.includes(id)) {
      return Response.json(
        { error: "Signature message must contain the TALOS ID" },
        { status: 400 }
      );
    }

    // Validate supersededBy references an existing agent if provided
    if (supersededBy) {
      const replacementAgent = await db.query.tlsTalos.findFirst({
        where: eq(tlsTalos.id, supersededBy),
      });
      if (!replacementAgent) {
        return Response.json(
          { error: "supersededBy must reference an existing agent" },
          { status: 400 }
        );
      }
    }

    // Use transaction for atomic operation
    const result = await db.transaction(async (tx) => {
      // Check if agent exists and is not already retired
      const talos = await tx.query.tlsTalos.findFirst({
        where: eq(tlsTalos.id, id),
      });

      if (!talos) {
        return { error: "TALOS not found", status: 404 };
      }

      if (talos.retiredAt) {
        return { error: "TALOS already retired", status: 400 };
      }

      // Only the creator wallet can retire
      if (
        talos.walletPublicKey !== stellarPublicKey &&
        talos.creatorPublicKey !== stellarPublicKey
      ) {
        return { error: "Unauthorized", status: 403 };
      }

      // Verify Stellar ED25519 signature proves wallet ownership
      try {
        const { Keypair } = await import("@stellar/stellar-sdk");
        const keypair = Keypair.fromPublicKey(stellarPublicKey);
        const messageBuffer = Buffer.from(message, "utf8");
        const signatureBuffer = Buffer.from(signature, "base64");
        const isValid = keypair.verify(messageBuffer, signatureBuffer);
        if (!isValid) {
          return { error: "Invalid signature", status: 403 };
        }
      } catch {
        return { error: "Invalid signature", status: 403 };
      }

      // Update agent with retirement status
      const [retiredTalos] = await tx
        .update(tlsTalos)
        .set({
          retiredAt: new Date(),
          retiredReason: reason,
          supersededBy: supersededBy || null,
          status: "Retired",
          agentOnline: false,
          updatedAt: new Date(),
        })
        .where(eq(tlsTalos.id, id))
        .returning();

      return { data: retiredTalos };
    });

    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({
      id: result.data.id,
      agentName: result.data.agentName,
      retiredAt: result.data.retiredAt,
      retiredReason: result.data.retiredReason,
      supersededBy: result.data.supersededBy,
    });
  } catch (error) {
    console.error("Error retiring TALOS:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
