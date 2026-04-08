import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsRevenues } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/revenue — Get revenue history
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

    const revenues = await db
      .select()
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id))
      .orderBy(desc(tlsRevenues.createdAt))
      .limit(50);

    return Response.json(revenues);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/revenue — Report revenue (from Local Agent)
// All revenue stays in Agent Treasury. No distribution to external wallets.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { amount, currency, source, txHash } = body;

    const validSources = ["commerce", "direct", "subscription"];
    const validCurrencies = ["USDC", "XLM", "USDT"];

    if (amount === undefined || !source) {
      return Response.json(
        { error: "amount, source are required" },
        { status: 400 }
      );
    }

    if (typeof amount !== "number" || amount <= 0) {
      return Response.json(
        { error: "amount must be a positive number" },
        { status: 400 }
      );
    }

    if (!validSources.includes(source)) {
      return Response.json(
        { error: `source must be one of: ${validSources.join(", ")}` },
        { status: 400 }
      );
    }

    if (currency && !validCurrencies.includes(currency)) {
      return Response.json(
        { error: `currency must be one of: ${validCurrencies.join(", ")}` },
        { status: 400 }
      );
    }

    // Record revenue in DB — all revenue stays in Agent Treasury
    const [revenue] = await db
      .insert(tlsRevenues)
      .values({
        talosId: id,
        amount: String(amount),
        currency: currency ?? "USDC",
        source,
        txHash,
      })
      .returning();

    return Response.json(revenue, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
