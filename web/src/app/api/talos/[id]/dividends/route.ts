import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsDividends } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";

// GET /api/talos/:id/dividends — List dividend distributions
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

    const dividends = await db
      .select()
      .from(tlsDividends)
      .where(eq(tlsDividends.talosId, id))
      .orderBy(desc(tlsDividends.createdAt))
      .limit(50);

    return Response.json(dividends);
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/dividends — Record dividend distribution (from Local Agent)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { amount, currency, txHash, totalPatrons, perShareAmount } = body;

    const validCurrencies = ["USDC", "XLM", "USDT"];

    if (amount === undefined) {
      return Response.json(
        { error: "amount is required" },
        { status: 400 }
      );
    }

    if (typeof amount !== "number" || amount <= 0) {
      return Response.json(
        { error: "amount must be a positive number" },
        { status: 400 }
      );
    }

    if (currency && !validCurrencies.includes(currency)) {
      return Response.json(
        { error: `currency must be one of: ${validCurrencies.join(", ")}` },
        { status: 400 }
      );
    }

    if (totalPatrons !== undefined && (typeof totalPatrons !== "number" || totalPatrons < 0 || !Number.isInteger(totalPatrons))) {
      return Response.json(
        { error: "totalPatrons must be a non-negative integer" },
        { status: 400 }
      );
    }

    if (perShareAmount !== undefined && (typeof perShareAmount !== "number" || perShareAmount < 0)) {
      return Response.json(
        { error: "perShareAmount must be a non-negative number" },
        { status: 400 }
      );
    }

    // Record dividend distribution in DB
    const [dividend] = await db
      .insert(tlsDividends)
      .values({
        talosId: id,
        amount: String(amount),
        currency: currency ?? "USDC",
        txHash,
        totalPatrons: totalPatrons ?? 0,
        perShareAmount: perShareAmount ? String(perShareAmount) : "0",
      })
      .returning();

    return Response.json(dividend, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
