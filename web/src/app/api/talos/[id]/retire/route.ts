import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsApprovals, tlsCommerceJobs, tlsTalos } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { retireAgentSchema, parseBody } from "@/lib/schemas";
import { evaluateLifecycleChecklist, toLifecycleState } from "@/lib/governance/lifecycle";
import { LIFECYCLE_EVENTS, emitLifecycleEvent } from "@/lib/governance/events";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// GET /api/talos/:id/retire - Owner-facing lifecycle & retirement checklist
// Returns blocking obligations and allowed next actions while preserving private financial details.
async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const viewer =
      request.nextUrl.searchParams.get("viewer") ||
      request.nextUrl.searchParams.get("address") ||
      request.nextUrl.searchParams.get("stellarPublicKey");

    const agent = await db.query.tlsTalos.findFirst({
      where: eq(tlsTalos.id, id),
    });

    if (!agent) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Require viewer address and verify owner authorization
    if (!viewer) {
      return Response.json(
        { error: "Viewer address is required", code: "LIFECYCLE_UNAUTHORIZED" },
        { status: 401 }
      );
    }

    const isOwner =
      viewer === agent.creatorPublicKey || viewer === agent.walletPublicKey;
    if (!isOwner) {
      return Response.json(
        {
          error: "Unauthorized: only agent owner can access retirement checklist",
          code: "LIFECYCLE_UNAUTHORIZED",
        },
        { status: 403 }
      );
    }

    // Query service availability & blocking obligations without exposing private details
    const [inFlightJobs, pendingApprovals] = await Promise.all([
      db
        .select({ id: tlsCommerceJobs.id })
        .from(tlsCommerceJobs)
        .where(
          and(
            eq(tlsCommerceJobs.talosId, id),
            inArray(tlsCommerceJobs.status, ["pending", "in_progress"])
          )
        )
        .limit(100),
      db
        .select({ id: tlsApprovals.id })
        .from(tlsApprovals)
        .where(and(eq(tlsApprovals.talosId, id), eq(tlsApprovals.status, "pending")))
        .limit(100),
    ]);

    const state = toLifecycleState(agent.status);
    const checklist = evaluateLifecycleChecklist({
      talosId: id,
      state,
      actor: { id: viewer, roles: ["creator", "operator"] },
      agentOnline: Boolean(agent.agentOnline),
      inFlightJobs: inFlightJobs.length,
      pendingProposalsCount: pendingApprovals.length,
      hasWallet: Boolean(agent.agentWalletId || agent.walletPublicKey),
      retiredAt: agent.retiredAt,
    });

    return Response.json(
      {
        ...checklist,
        agentName: agent.agentName,
        retiredAt: agent.retiredAt,
        retiredReason: agent.retiredReason,
        supersededBy: agent.supersededBy,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    logger.error({ error, talosId: id }, "Error fetching retirement checklist");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/retire - Retire an agent (preserves history, prevents reuse)
// Requires Stellar ED25519 signature proof of wallet ownership.
async function _POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const parsed = await parseBody(request, retireAgentSchema);
    if (parsed.error) return parsed.error;

    const { reason, supersededBy, stellarPublicKey, signature, message, drainJobs } =
      parsed.data;

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

      // Check blocking obligations: in-flight jobs must be drained unless drainJobs is explicitly false
      const inFlightJobs = await tx
        .select({ id: tlsCommerceJobs.id })
        .from(tlsCommerceJobs)
        .where(
          and(
            eq(tlsCommerceJobs.talosId, id),
            inArray(tlsCommerceJobs.status, ["pending", "in_progress"])
          )
        )
        .limit(10);

      const shouldDrain = drainJobs ?? true;
      if (inFlightJobs.length > 0 && shouldDrain) {
        return {
          error: `Cannot retire agent with ${inFlightJobs.length} in-flight job(s). Drain pending work before retiring.`,
          code: "LIFECYCLE_PREREQUISITE_FAILED",
          status: 409,
          details: { inFlightJobs: inFlightJobs.length },
        };
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

      // Emit lifecycle event to governance audit trail
      await emitLifecycleEvent(
        {
          talosId: id,
          eventType: LIFECYCLE_EVENTS.RETIRED,
          fromState: toLifecycleState(talos.status),
          toState: "retired",
          actorId: stellarPublicKey,
          actorRole: "creator",
          detail: { reason, supersededBy: supersededBy || null },
        },
        tx
      ).catch((err) => {
        logger.warn({ err }, "failed to emit lifecycle event on retire");
      });

      return { data: retiredTalos };
    });

    if ("error" in result) {
      return Response.json(
        { error: result.error, code: result.code, details: result.details },
        { status: result.status }
      );
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

export const GET = withRequestId(_GET);
export const POST = withRequestId(_POST);
