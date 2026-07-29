/**
 * GET  /api/talos/:id/lifecycle — current state, allowed actions, run progress,
 *                                 and a keyset-paginated transition history.
 * POST /api/talos/:id/lifecycle — request a governed lifecycle transition.
 *
 * Authorization is wallet-signature based, matching `regenerate-key`: the
 * caller proves control of an address, and the address is then mapped onto a
 * governance role by its relationship to the agent record. Consequential
 * actions additionally require an explicit `confirmed: true` in the payload, so
 * a replayed or CSRF-shaped request cannot retire an agent by accident.
 */
import { NextRequest } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { tlsApprovals, tlsCommerceJobs, tlsProvisioningJobs, tlsTalos } from "@/db/schema";
import { logger } from "@/lib/logger";
import { LIFECYCLE_EVENTS, emitLifecycleEvent, readLifecycleEvents } from "@/lib/governance/events";
import {
  LifecycleError,
  allowedActions,
  evaluateTransition,
  toLegacyStatus,
  toLifecycleState,
  type GovernanceRole,
  type LifecycleActor,
} from "@/lib/governance/lifecycle";
import { assertPrerequisites, parseLifecyclePayload } from "@/lib/governance/payloads";
import { databaseEffects } from "@/lib/governance/effects";
import { submitProvisioningJob, workflowFor } from "@/lib/governance/provisioning";
import { parseLimit } from "@/lib/parse-limit";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16_384;

// ── Helpers ──────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof LifecycleError) {
    return Response.json(err.toResponseBody(), { status: err.status });
  }
  logger.error({ event: "lifecycle.unhandled", err: String(err) }, "lifecycle request failed");
  return Response.json(
    { error: "Internal server error", code: "LIFECYCLE_INTERNAL", details: {} },
    { status: 500 },
  );
}

/** Map a proven address onto the roles it holds for this agent. */
function rolesFor(
  address: string,
  agent: { creatorPublicKey: string | null; walletPublicKey: string | null; treasuryPublicKey: string | null },
): GovernanceRole[] {
  const roles: GovernanceRole[] = [];
  if (agent.creatorPublicKey === address) roles.push("creator", "operator");
  if (agent.walletPublicKey === address) roles.push("operator");
  // The treasury key is the protocol-governance signer of record.
  if (agent.treasuryPublicKey === address) roles.push("governance");
  return [...new Set(roles)];
}

async function verifySignature(
  address: string,
  message: string,
  signature: string,
  talosId: string,
): Promise<void> {
  // Binding the agent id into the signed message stops a signature collected
  // for one agent from being replayed against another.
  if (!message.includes(talosId)) {
    throw new LifecycleError(
      "LIFECYCLE_UNAUTHORIZED",
      "Signature message must contain the TALOS ID",
    );
  }

  try {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const keypair = Keypair.fromPublicKey(address);
    const valid = keypair.verify(Buffer.from(message, "utf8"), Buffer.from(signature, "base64"));
    if (!valid) throw new Error("bad signature");
  } catch {
    throw new LifecycleError("LIFECYCLE_UNAUTHORIZED", "Invalid signature");
  }
}

async function loadAgent(id: string) {
  return db
    .select({
      id: tlsTalos.id,
      status: tlsTalos.status,
      creatorPublicKey: tlsTalos.creatorPublicKey,
      walletPublicKey: tlsTalos.walletPublicKey,
      treasuryPublicKey: tlsTalos.treasuryPublicKey,
      agentWalletId: tlsTalos.agentWalletId,
      agentOnline: tlsTalos.agentOnline,
      agentLastSeen: tlsTalos.agentLastSeen,
      updatedAt: tlsTalos.updatedAt,
    })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, id))
    .limit(1)
    .then((r) => r[0] ?? null);
}

// ── GET ──────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const agent = await loadAgent(id);
    if (!agent) return Response.json({ error: "TALOS not found" }, { status: 404 });

    const state = toLifecycleState(agent.status);

    const viewer = request.nextUrl.searchParams.get("viewer");
    // Unauthenticated viewers see history but are offered no actions.
    const viewerRoles = viewer ? rolesFor(viewer, agent) : [];

    const parsedLimit = parseLimit(request.nextUrl.searchParams.get("limit"), 25, 100);
    if (!parsedLimit.ok) return parsedLimit.response;
    const limit = parsedLimit.limit;

    const beforeRaw = request.nextUrl.searchParams.get("before");
    const before = beforeRaw ? Number.parseInt(beforeRaw, 10) : undefined;

    const [{ events, nextCursor }, run, pendingProposals, inFlightJobs] = await Promise.all([
      readLifecycleEvents(id, {
        limit,
        beforeSequence: Number.isFinite(before) && before! > 0 ? before : undefined,
      }),
      db
        .select({
          id: tlsProvisioningJobs.id,
          action: tlsProvisioningJobs.action,
          status: tlsProvisioningJobs.status,
          steps: tlsProvisioningJobs.steps,
          cursor: tlsProvisioningJobs.cursor,
          attempt: tlsProvisioningJobs.attempt,
          maxAttempts: tlsProvisioningJobs.maxAttempts,
          lastError: tlsProvisioningJobs.lastError,
          createdAt: tlsProvisioningJobs.createdAt,
          completedAt: tlsProvisioningJobs.completedAt,
        })
        .from(tlsProvisioningJobs)
        .where(eq(tlsProvisioningJobs.talosId, id))
        .orderBy(desc(tlsProvisioningJobs.createdAt))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ id: tlsApprovals.id, title: tlsApprovals.title, type: tlsApprovals.type })
        .from(tlsApprovals)
        .where(and(eq(tlsApprovals.talosId, id), eq(tlsApprovals.status, "pending")))
        .limit(20),
      db
        .select({ id: tlsCommerceJobs.id })
        .from(tlsCommerceJobs)
        .where(
          and(
            eq(tlsCommerceJobs.talosId, id),
            inArray(tlsCommerceJobs.status, ["pending", "in_progress"]),
          ),
        )
        .limit(100),
    ]);

    return Response.json(
      {
        talosId: id,
        state,
        legacyStatus: toLegacyStatus(state),
        // Clients render a "may be stale" affordance from these two fields
        // rather than assuming the snapshot is live.
        observedAt: new Date().toISOString(),
        stateChangedAt: agent.updatedAt,
        agentOnline: agent.agentOnline,
        agentLastSeen: agent.agentLastSeen,
        allowedActions: viewerRoles.length
          ? allowedActions(state, { id: viewer!, roles: viewerRoles })
          : [],
        viewerRoles,
        inFlightJobs: inFlightJobs.length,
        pendingProposals,
        run,
        events,
        nextCursor,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// ── POST ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return Response.json(
        { error: "Request body too large", code: "LIFECYCLE_INVALID_PAYLOAD", details: {} },
        { status: 413 },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new LifecycleError("LIFECYCLE_INVALID_PAYLOAD", "Invalid JSON body");
    }

    const address = typeof body.address === "string" ? body.address : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const message = typeof body.message === "string" ? body.message : "";

    if (!address || !signature || !message) {
      throw new LifecycleError(
        "LIFECYCLE_UNAUTHORIZED",
        "address, signature, and message are required",
      );
    }

    const agent = await loadAgent(id);
    if (!agent) return Response.json({ error: "TALOS not found" }, { status: 404 });

    await verifySignature(address, message, signature, id);

    const actor: LifecycleActor = { id: address, roles: rolesFor(address, agent) };
    if (actor.roles.length === 0) {
      throw new LifecycleError("LIFECYCLE_UNAUTHORIZED", "Address holds no role on this agent");
    }

    const parsed = parseLifecyclePayload(body);
    const from = toLifecycleState(agent.status);

    // A governance-gated action is backed by an approved proposal record, not
    // by a flag the client sets on itself.
    const governanceApproved = await hasApprovedProposal(id, parsed);

    const decision = evaluateTransition({
      action: parsed.action,
      from,
      actor,
      governanceApproved,
    });

    const inFlight = await db
      .select({ id: tlsCommerceJobs.id })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, id),
          inArray(tlsCommerceJobs.status, ["pending", "in_progress"]),
        ),
      )
      .limit(100);

    assertPrerequisites(parsed, {
      operator: agent.creatorPublicKey,
      grantedPermissions: parsed.action === "create" ? parsed.payload.permissions : ["wallet.read"],
      hasWallet: Boolean(agent.agentWalletId),
      serviceCount: 0,
      inFlightJobs: inFlight.length,
    });

    const idempotencyKey =
      ("idempotencyKey" in parsed.payload && parsed.payload.idempotencyKey) ||
      request.headers.get("idempotency-key") ||
      `${parsed.action}:${from}:${address}`;

    // Durable actions hand off to the provisioning worker and return 202 —
    // the client polls GET for progress rather than holding a request open.
    if (decision.durable) {
      const workflow = workflowFor(parsed.action, databaseEffects);
      const { jobId, created } = await submitProvisioningJob({
        talosId: id,
        action: parsed.action,
        requestedBy: address,
        idempotencyKey,
        workflow,
      });

      await emitLifecycleEvent({
        talosId: id,
        eventType:
          parsed.action === "retire"
            ? LIFECYCLE_EVENTS.RETIRING
            : LIFECYCLE_EVENTS.PROVISIONING_STARTED,
        fromState: from,
        toState: decision.to,
        actorId: address,
        actorRole: actor.roles[0],
        jobId,
        detail: { action: parsed.action },
        idempotencyKey: `${jobId}:requested`,
      });

      await db
        .update(tlsTalos)
        .set({ status: toLegacyStatus(decision.to) })
        .where(eq(tlsTalos.id, id));

      return Response.json(
        { talosId: id, state: decision.to, jobId, created, action: parsed.action },
        { status: 202 },
      );
    }

    // Inline transitions settle immediately.
    if (parsed.action === "pause" && parsed.payload.cancelPendingJobs) {
      await db
        .update(tlsCommerceJobs)
        .set({ status: "cancelled", leasedBy: null, leasedAt: null, leaseExpiresAt: null })
        .where(and(eq(tlsCommerceJobs.talosId, id), eq(tlsCommerceJobs.status, "pending")));
    }

    await db
      .update(tlsTalos)
      .set({
        status: toLegacyStatus(decision.to),
        agentOnline: decision.to === "active",
        agentLastSeen: new Date(),
      })
      .where(eq(tlsTalos.id, id));

    const eventType =
      decision.to === "active"
        ? LIFECYCLE_EVENTS.ACTIVATED
        : decision.to === "paused"
          ? LIFECYCLE_EVENTS.PAUSED
          : decision.to === "recovery_pending"
            ? LIFECYCLE_EVENTS.RECOVERY_REQUESTED
            : LIFECYCLE_EVENTS.PROPOSED;

    await emitLifecycleEvent({
      talosId: id,
      eventType,
      fromState: from,
      toState: decision.to,
      actorId: address,
      actorRole: actor.roles[0],
      detail: { action: parsed.action },
      idempotencyKey: `${id}:${idempotencyKey}`,
    });

    logger.info(
      { event: "lifecycle.transition", talosId: id, action: parsed.action, from, to: decision.to },
      "lifecycle transition applied",
    );

    return Response.json({ talosId: id, state: decision.to, action: parsed.action });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * A gated action must point at an approved proposal. Actions that are not gated
 * short-circuit to `true` so the state machine's own rule decides.
 */
async function hasApprovedProposal(
  talosId: string,
  parsed: ReturnType<typeof parseLifecyclePayload>,
): Promise<boolean> {
  if (!("proposalId" in parsed.payload) || !parsed.payload.proposalId) return false;

  const row = await db
    .select({ id: tlsApprovals.id })
    .from(tlsApprovals)
    .where(
      and(
        eq(tlsApprovals.id, parsed.payload.proposalId),
        eq(tlsApprovals.talosId, talosId),
        eq(tlsApprovals.status, "approved"),
      ),
    )
    .limit(1);

  return row.length > 0;
}
