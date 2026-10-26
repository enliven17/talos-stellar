import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { tlsTalos } from '@/db/schema';
import { verifySignature, parseSignedMessage } from '@/lib/stellar/verify';
import { agentMutationTags } from '@/lib/revalidate';
import { getAgentById } from '@/lib/db/agents';

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const parsed = parseSignedMessage(await request.text());
    if (parsed.error) return parsed.error;

    const { reason, stellarPublicKey, signature, message } = parsed.data;

    // Verify the message contains the TALOS ID to prevent replay across TALOSes
    if (!message.includes(id)) {
      for (const tag of agentMutationTags(id)) revalidateTag(tag, "max");
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
        return Response.json(
          { error: "Agent not found" },
          { status: 404 }
        );
      }

      // Soft delete: set deletedAt and updatedAt
      await tx.update(tlsTalos)
        .set({
          deletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tlsTalos.id, id));

      // Revalidate agent detail cache
      for (const tag of agentMutationTags(id)) revalidateTag(tag, "max");

      return Response.json({ success: true, id });
    });

    return result;
  } catch (error) {
    console.error('Delete agent error:', error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
