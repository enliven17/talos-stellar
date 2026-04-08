import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsApprovals, tlsPatrons } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { recordApprovalOnChain } from "@/lib/stellar";

// PATCH /api/talos/:id/approvals/:approvalId — Approve/reject
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; approvalId: string }> }
) {
  const { id, approvalId } = await params;

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

    const existing = await db
      .select()
      .from(tlsApprovals)
      .where(eq(tlsApprovals.id, approvalId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!existing || existing.talosId !== id) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }

    const body = await request.json();
    const { status, decidedBy } = body;

    if (!status || !["approved", "rejected"].includes(status)) {
      return Response.json(
        { error: "status must be 'approved' or 'rejected'" },
        { status: 400 }
      );
    }

    if (!decidedBy) {
      return Response.json(
        { error: "decidedBy (Stellar public key) is required" },
        { status: 400 }
      );
    }

    // Verify the caller is an active Patron (Creator or Investor) of this TALOS
    const patron = await db
      .select()
      .from(tlsPatrons)
      .where(
        and(
          eq(tlsPatrons.talosId, id),
          eq(sql`${tlsPatrons.stellarPublicKey}`, decidedBy),
          eq(tlsPatrons.status, "active")
        )
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!patron) {
      return Response.json(
        { error: "Only active Patrons can approve or reject decisions" },
        { status: 403 }
      );
    }

    // Record approval decision on Stellar
    const onChainResult = await recordApprovalOnChain(
      approvalId,
      id,
      status,
      decidedBy,
    );

    const [approval] = await db
      .update(tlsApprovals)
      .set({
        status,
        decidedAt: new Date(),
        decidedBy,
        txHash: onChainResult?.txHash ?? null,
      })
      .where(eq(tlsApprovals.id, approvalId))
      .returning();

    return Response.json(approval);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
