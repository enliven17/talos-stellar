import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsApprovals, tlsPatrons } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/approvals — Pending approval list
// Public read (no auth) — patrons need to see approvals to vote
// Agent-authenticated write is handled in POST
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const cursor = searchParams.get("cursor");
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 1), 200);

  try {
    const conditions = [eq(tlsApprovals.talosId, id)];
    if (status) conditions.push(eq(tlsApprovals.status, status));
    if (cursor) conditions.push(sql`${tlsApprovals.createdAt} < ${new Date(cursor)}`);

    const rows = await db
      .select()
      .from(tlsApprovals)
      .where(and(...conditions))
      .orderBy(desc(tlsApprovals.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const approvals = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? approvals[approvals.length - 1]?.createdAt.toISOString() ?? null : null;

    return Response.json({ approvals, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/approvals — Create approval request
// Can be called by: local agent (Bearer api_key) OR active patron (proposerPublicKey)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const talos = await db
      .select()
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    const body = await request.json();
    const { type, title, description, amount, proposerPublicKey } = body;

    // Auth: either agent API key or active patron
    const authHeader = request.headers.get("authorization");
    const isAgentAuth = authHeader?.startsWith("Bearer ");

    if (!isAgentAuth) {
      if (!proposerPublicKey) {
        return Response.json({ error: "proposerPublicKey required for patron proposals" }, { status: 401 });
      }
      const patron = await db
        .select({ id: tlsPatrons.id })
        .from(tlsPatrons)
        .where(and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.stellarPublicKey, proposerPublicKey), eq(tlsPatrons.status, "active")))
        .limit(1)
        .then(r => r[0] ?? null);
      if (!patron) {
        return Response.json({ error: "Only active patrons can propose approvals" }, { status: 403 });
      }
    }

    const validTypes = ["transaction", "strategy", "policy", "channel"];

    if (!type || !title) {
      return Response.json(
        { error: "type, title are required" },
        { status: 400 }
      );
    }

    if (!validTypes.includes(type)) {
      return Response.json(
        { error: `type must be one of: ${validTypes.join(", ")}` },
        { status: 400 }
      );
    }

    if (amount !== undefined && (typeof amount !== "number" || amount < 0)) {
      return Response.json(
        { error: "amount must be a non-negative number" },
        { status: 400 }
      );
    }

    // State machine guard: prevent duplicate pending approvals of the same type.
    // Agent should resolve the existing one before creating another.
    const existing = await db
      .select({ id: tlsApprovals.id })
      .from(tlsApprovals)
      .where(
        and(
          eq(tlsApprovals.talosId, id),
          eq(tlsApprovals.type, type),
          eq(tlsApprovals.status, "pending"),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);

    if (existing) {
      return Response.json(
        {
          error: "An approval of this type is already pending",
          existingId: existing.id,
        },
        { status: 409 },
      );
    }

    const [approval] = await db
      .insert(tlsApprovals)
      .values({
        talosId: id,
        type,
        title,
        description,
        amount: amount != null ? String(amount) : undefined,
      })
      .returning();

    return Response.json(approval, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
