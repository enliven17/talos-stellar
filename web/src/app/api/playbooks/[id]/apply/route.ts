import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsPlaybooks, tlsPlaybookPurchases } from "@/db/schema";
import { and, eq } from "drizzle-orm";

// PATCH /api/playbooks/:id/apply — Mark a purchased playbook as applied
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const body = await request.json();
    const { buyerPublicKey } = body;

    if (!buyerPublicKey) {
      return Response.json(
        { error: "buyerPublicKey is required" },
        { status: 400 }
      );
    }

    // Verify playbook exists
    const playbook = await db
      .select()
      .from(tlsPlaybooks)
      .where(eq(tlsPlaybooks.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!playbook) {
      return Response.json({ error: "Playbook not found" }, { status: 404 });
    }

    // Verify purchase exists
    const purchase = await db
      .select()
      .from(tlsPlaybookPurchases)
      .where(
        and(
          eq(tlsPlaybookPurchases.playbookId, id),
          eq(tlsPlaybookPurchases.buyerPublicKey, buyerPublicKey)
        )
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!purchase) {
      return Response.json(
        { error: "No purchase found for this playbook and wallet" },
        { status: 404 }
      );
    }

    if (purchase.appliedAt) {
      return Response.json(
        { error: "Playbook already applied", appliedAt: purchase.appliedAt },
        { status: 409 }
      );
    }

    // Mark as applied
    const [updated] = await db
      .update(tlsPlaybookPurchases)
      .set({ appliedAt: new Date() })
      .where(eq(tlsPlaybookPurchases.id, purchase.id))
      .returning();

    return Response.json({
      ...updated,
      content: playbook.content,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
