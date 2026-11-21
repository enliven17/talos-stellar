/**
 * GET  /api/talos/:id/owner-transfer — Preview the ownership transfer
 * POST /api/talos/:id/owner-transfer — Execute the ownership transfer
 *
 * GET returns the affected permissions and obligations without any mutation.
 * POST requires a fresh `expectedOwner` value that must match the current
 * owner at execution time — if another transfer has already happened the
 * request is rejected with 409 to prevent blind overwrites.
 *
 * Response shapes
 * ───────────────
 *   GET  200  OwnerTransferPreview
 *   GET  404  { error: "TALOS not found" }
 *   GET  409  { error: "...", code: "LIFECYCLE_TERMINAL_STATE" }  — retired
 *
 *   POST 200  { agentId, previousOwner, newOwner, transferredAt }
 *   POST 400  { error: string }  — validation failure
 *   POST 403  { error: string }  — not authorised
 *   POST 404  { error: "TALOS not found" }
 *   POST 409  { error: string, code: "LIFECYCLE_CONFLICT" }  — owner mismatch
 */

import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsCommerceJobs, tlsRevenues, tlsDividends, tlsPatrons } from "@/db/schema";
import { and, eq, not, inArray, sql, gt } from "drizzle-orm";
import { withTraceContext } from "@/lib/tracing";
import { buildOwnerTransferPreview } from "@/lib/governance/owner-transfer";

const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

// ── Preview (GET) ─────────────────────────────────────────────────────────────

async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const agent = await db
      .select({
        id: tlsTalos.id,
        creatorPublicKey: tlsTalos.creatorPublicKey,
        retiredAt: tlsTalos.retiredAt,
      })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    if (agent.retiredAt) {
      return Response.json(
        {
          error: "Agent is retired; no further lifecycle transitions are possible",
          code: "LIFECYCLE_TERMINAL_STATE",
        },
        { status: 409 },
      );
    }

    // Gather permissions from approved proposals (approvals table has no permissions column;
    // we surface the lifecycle-defined AGENT_PERMISSIONS from the payloads module instead,
    // which represent the governance-granted capabilities for this agent).
    // For the preview we report the well-known capability set so the new owner knows
    // what they are inheriting without querying a separate registry.
    const { AGENT_PERMISSIONS } = await import("@/lib/governance/payloads");
    const grantedPermissions: string[] = [...AGENT_PERMISSIONS];

    // Pending jobs
    const [pendingJobsRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, id),
          not(inArray(tlsCommerceJobs.status, [...TERMINAL_JOB_STATUSES])),
        ),
      );

    // Undistributed revenue
    const [revenueRow] = await db
      .select({ total: sql<string>`coalesce(sum(${tlsRevenues.amount}), '0')` })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id));

    const [dividendRow] = await db
      .select({ total: sql<string>`coalesce(sum(${tlsDividends.amount}), '0')` })
      .from(tlsDividends)
      .where(and(eq(tlsDividends.talosId, id), eq(tlsDividends.status, "completed")));

    const undistributedRevenueUSDC = Math.max(
      0,
      Number(revenueRow?.total ?? "0") - Number(dividendRow?.total ?? "0"),
    );

    // Active patron count (patrons with a non-zero pulse balance)
    const [patronRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(tlsPatrons)
      .where(and(eq(tlsPatrons.talosId, id), gt(tlsPatrons.pulseAmount, 0)));

    const preview = buildOwnerTransferPreview({
      agentId: id,
      currentOwner: agent.creatorPublicKey ?? null,
      grantedPermissions,
      pendingJobs: pendingJobsRow?.count ?? 0,
      undistributedRevenueUSDC,
      activePatronCount: patronRow?.count ?? 0,
    });

    return Response.json(preview);
  } catch (err) {
    console.error("Error building owner transfer preview:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ── Execute (POST) ────────────────────────────────────────────────────────────

async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return Response.json({ error: "Request body must be an object" }, { status: 400 });
    }

    const { expectedOwner, newOwner, requestedBy } = body as Record<string, unknown>;

    // Validate required fields
    if (typeof newOwner !== "string" || !/^G[A-Z2-7]{55}$/.test(newOwner)) {
      return Response.json(
        { error: "newOwner must be a valid Stellar G-address" },
        { status: 400 },
      );
    }

    if (typeof expectedOwner !== "string" || !/^G[A-Z2-7]{55}$/.test(expectedOwner)) {
      return Response.json(
        {
          error:
            "expectedOwner must be a valid Stellar G-address matching the current owner — fetch GET /owner-transfer to obtain it",
        },
        { status: 400 },
      );
    }

    if (typeof requestedBy !== "string" || !/^G[A-Z2-7]{55}$/.test(requestedBy)) {
      return Response.json(
        { error: "requestedBy must be a valid Stellar G-address" },
        { status: 400 },
      );
    }

    if (newOwner === expectedOwner) {
      return Response.json(
        { error: "newOwner must differ from the current owner" },
        { status: 400 },
      );
    }

    const result = await db.transaction(async (tx) => {
      const agent = await tx
        .select({
          id: tlsTalos.id,
          creatorPublicKey: tlsTalos.creatorPublicKey,
          retiredAt: tlsTalos.retiredAt,
        })
        .from(tlsTalos)
        .where(eq(tlsTalos.id, id))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!agent) {
        return { error: "TALOS not found", status: 404 } as const;
      }

      if (agent.retiredAt) {
        return {
          error: "Agent is retired; no further lifecycle transitions are possible",
          code: "LIFECYCLE_TERMINAL_STATE",
          status: 409,
        } as const;
      }

      // Authorisation: only the current owner may initiate a transfer
      if (agent.creatorPublicKey !== requestedBy) {
        return { error: "Unauthorized: requestedBy does not match the current owner", status: 403 } as const;
      }

      // Optimistic concurrency: reject if ownership has changed since the preview
      if (agent.creatorPublicKey !== expectedOwner) {
        return {
          error:
            "Owner has changed since the preview was fetched — re-fetch GET /owner-transfer and retry",
          code: "LIFECYCLE_CONFLICT",
          status: 409,
        } as const;
      }

      const [updated] = await tx
        .update(tlsTalos)
        .set({
          creatorPublicKey: newOwner,
          updatedAt: new Date(),
        })
        .where(eq(tlsTalos.id, id))
        .returning({
          id: tlsTalos.id,
          creatorPublicKey: tlsTalos.creatorPublicKey,
          updatedAt: tlsTalos.updatedAt,
        });

      return { data: { previousOwner: expectedOwner, updated } } as const;
    });

    if ("error" in result) {
      return Response.json(
        { error: result.error, ...("code" in result ? { code: result.code } : {}) },
        { status: result.status },
      );
    }

    return Response.json({
      agentId: id,
      previousOwner: result.data.previousOwner,
      newOwner: result.data.updated.creatorPublicKey,
      transferredAt: result.data.updated.updatedAt?.toISOString() ?? new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error executing owner transfer:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTraceContext(handleGet);
export const POST = withTraceContext(handlePost);
