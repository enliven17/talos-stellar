import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsApprovals } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/approvals — Pending approval list
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const approvals = await db
      .select()
      .from(tlsApprovals)
      .where(eq(tlsApprovals.talosId, id))
      .orderBy(desc(tlsApprovals.createdAt));

    return Response.json(approvals);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/approvals — Create approval request (from Local Agent)
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
    const { type, title, description, amount } = body;

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
