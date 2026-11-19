import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs, tlsRevenues, tlsDividends } from "@/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { retireAgentSchema, parseBody } from "@/lib/schemas";
import { buildRetirementReadinessReport } from "@/lib/governance/retirement-readiness";

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

    // ── Readiness check — block if pending obligations exist ─────────────
    const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

    const [[pendingJobsRow], [pendingPaymentsRow], [revenueRow], [dividendRow]] = await Promise.all(
      [
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(tlsCommerceJobs)
          .where(
            and(
              eq(tlsCommerceJobs.talosId, id),
              notInArray(tlsCommerceJobs.status, [...TERMINAL_JOB_STATUSES]),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(tlsCommerceJobs)
          .where(and(eq(tlsCommerceJobs.talosId, id), eq(tlsCommerceJobs.status, "pending"))),
        db
          .select({ total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')` })
          .from(tlsRevenues)
          .where(eq(tlsRevenues.talosId, id)),
        db
          .select({ total: sql<string>`coalesce(sum(${tlsDividends.amount}), '0')` })
          .from(tlsDividends)
          .where(and(eq(tlsDividends.talosId, id), eq(tlsDividends.status, "completed"))),
      ],
    );

    const totalRevenue = parseFloat(revenueRow?.total ?? "0");
    const totalDistributed = parseFloat(dividendRow?.total ?? "0");
    const undistributedRevenueUSDC = Math.max(0, totalRevenue - totalDistributed);

    const readinessReport = buildRetirementReadinessReport({
      agentId: id,
      pendingJobs: pendingJobsRow?.count ?? 0,
      pendingPayments: pendingPaymentsRow?.count ?? 0,
      undistributedRevenueUSDC,
      currentState: "active",
    });

    if (!readinessReport.ready) {
      return Response.json(
        {
          error: "Agent has pending financial obligations and cannot be retired",
          code: "LIFECYCLE_PREREQUISITE_FAILED",
          report: readinessReport,
        },
        { status: 422 },
      );
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
