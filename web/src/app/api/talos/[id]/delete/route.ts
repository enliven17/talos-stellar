import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsActivities, tlsApprovals, tlsCommerceJobs, tlsCommerceServices, tlsPlaybooks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deleteAgentSchema, parseBody } from "@/lib/schemas";

// POST /api/talos/:id/delete - Privacy deletion (soft delete, preserves historical links)
// Requires Stellar ED25519 signature proof of wallet ownership.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const parsed = await parseBody(request, deleteAgentSchema);
    if (parsed.error) return parsed.error;

    const { reason, stellarPublicKey, signature, message } = parsed.data;

    // Verify the message contains the TALOS ID to prevent replay across TALOSes
    if (!message.includes(id)) {
      return Response.json(
        { error: "Signature message must contain the TALOS ID" },
        { status: 400 }
      );
    }

    // Use transaction for atomic operation
    const result = await db.transaction(async (tx) => {
      // Check if agent exists and is not already deleted
      const talos = await tx.query.tlsTalos.findFirst({
        where: eq(tlsTalos.id, id),
      });

      if (!talos) {
        return { error: "TALOS not found", status: 404 };
      }

      if (talos.deletedAt) {
        return { error: "TALOS already deleted", status: 400 };
      }

      // Only the creator wallet can delete
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

      // Soft delete the agent record (preserves ID and historical links)
      const [deletedTalos] = await tx
        .update(tlsTalos)
        .set({
          deletedAt: new Date(),
          deletedReason: reason,
          // Clear sensitive fields but preserve identity
          apiKey: null,
          agentWalletId: null,
          agentWalletAddress: null,
          walletPublicKey: null,
          creatorPublicKey: null,
          investorPublicKey: null,
          treasuryPublicKey: null,
          updatedAt: new Date(),
        })
        .where(eq(tlsTalos.id, id))
        .returning();

      // Mark related records as deleted (soft delete for historical preservation)
      await tx
        .update(tlsPatrons)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(tlsPatrons.talosId, id));

      await tx
        .update(tlsActivities)
        .set({ status: "deleted" })
        .where(eq(tlsActivities.talosId, id));

      await tx
        .update(tlsApprovals)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(tlsApprovals.talosId, id));

      await tx
        .update(tlsCommerceServices)
        .set({ updatedAt: new Date() })
        .where(eq(tlsCommerceServices.talosId, id));

      await tx
        .update(tlsCommerceJobs)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(tlsCommerceJobs.talosId, id));

      await tx
        .update(tlsPlaybooks)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(tlsPlaybooks.talosId, id));

      return { data: deletedTalos };
    });

    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({
      id: result.data.id,
      agentName: result.data.agentName,
      deletedAt: result.data.deletedAt,
      deletedReason: result.data.deletedReason,
      message: "Agent soft-deleted. Historical records preserved.",
    });
  } catch (error) {
    console.error("Error deleting TALOS:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
