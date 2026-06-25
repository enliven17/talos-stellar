import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsDividends } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { recordDividendSchema, parseBody } from "@/lib/schemas";

/**
 * GET /api/talos/:id/dividends
 *
 * List dividend distribution history for a TALOS so Patrons can track the
 * revenue that has been shared out to Mitos/Pulse token holders over time.
 *
 * Public read (consistent with revenue history + RLS anon_read policy).
 * Returns the most recent 50 distributions, newest first.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

/**
 * POST /api/talos/:id/dividends
 *
 * Record a new dividend distribution event in the database.
 *
 * This is a privileged financial write (the agent/operator records that a
 * distribution to patrons occurred), so it requires the TALOS API key via
 * `Authorization: Bearer <api_key>` — consistent with POST /revenue.
 *
 * Body:
 *   amount       — total distributed (string or positive number)  [required]
 *   currency     — default "USDC"
 *   patronCount  — number of patrons paid in this event
 *   totalPulse   — total Mitos/Pulse held by recipients at distribution time
 *   source       — e.g. "revenue-share" | "manual"
 *   txHash       — optional on-chain settlement reference
 *   breakdown    — optional per-patron array
 *   status       — "completed" | "pending" | "failed"
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id);
    if (!auth.ok) return auth.response;

    const parsed = await parseBody(request, recordDividendSchema);
    if (parsed.error) return parsed.error;

    const {
      amount,
      currency,
      patronCount,
      totalPulse,
      source,
      txHash,
      breakdown,
      status,
    } = parsed.data;

    // Normalize amount to a string for the numeric column and guard against
    // non-positive / non-finite values that Zod's union may let through.
    const amountNum = typeof amount === "number" ? amount : parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return Response.json(
        { error: "amount must be a positive number" },
        { status: 400 },
      );
    }

    const [dividend] = await db
      .insert(tlsDividends)
      .values({
        talosId: id,
        amount: String(amount),
        currency: currency ?? "USDC",
        patronCount: patronCount ?? 0,
        totalPulse: totalPulse ?? 0,
        source: source ?? "revenue-share",
        txHash: txHash ?? null,
        breakdown: breakdown ?? null,
        status: status ?? "completed",
      })
      .returning();

    return Response.json(dividend, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
