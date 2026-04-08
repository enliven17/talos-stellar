import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPlaybooks, tlsPlaybookPurchases, tlsRevenues } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyX402Payment, settleX402Payment } from "@/lib/stellar-x402";

// POST /api/playbooks/:id/purchase — Purchase a playbook via Stellar x402 payment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Authenticate buyer via Bearer API key
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json(
        { error: "Missing Authorization header. Use: Bearer <api_key>" },
        { status: 401 },
      );
    }
    const apiKeyToken = authHeader.slice(7);
    const buyer = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.apiKey, apiKeyToken))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!buyer) {
      return Response.json({ error: "Invalid API key" }, { status: 403 });
    }

    const body = await request.json();
    const { buyerPublicKey, paymentToken } = body;

    if (!buyerPublicKey || !paymentToken) {
      return Response.json(
        { error: "buyerPublicKey and paymentToken are required" },
        { status: 400 },
      );
    }

    const playbook = await db
      .select()
      .from(tlsPlaybooks)
      .where(eq(tlsPlaybooks.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!playbook) {
      return Response.json({ error: "Playbook not found" }, { status: 404 });
    }
    if (playbook.status !== "active") {
      return Response.json({ error: "Playbook is not available for purchase" }, { status: 400 });
    }

    // Replay prevention — check paymentToken hash against existing purchases
    const existingBySig = await db
      .select({ id: tlsPlaybookPurchases.id })
      .from(tlsPlaybookPurchases)
      .where(eq(tlsPlaybookPurchases.txHash, paymentToken))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existingBySig) {
      return Response.json({ error: "Payment token already used (replay detected)" }, { status: 409 });
    }

    // Check for duplicate purchase (same buyer + same playbook)
    const existing = await db
      .select()
      .from(tlsPlaybookPurchases)
      .where(
        and(
          eq(tlsPlaybookPurchases.playbookId, id),
          eq(tlsPlaybookPurchases.buyerPublicKey, buyerPublicKey),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);
    if (existing) {
      return Response.json({ error: "Already purchased this playbook" }, { status: 409 });
    }

    // Get seller wallet for payment verification
    const seller = await db
      .select({ agentWalletAddress: tlsTalos.agentWalletAddress, walletPublicKey: tlsTalos.walletPublicKey })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, playbook.talosId))
      .limit(1)
      .then((r) => r[0] ?? null);

    const expectedPayee = seller?.agentWalletAddress || seller?.walletPublicKey || "";

    // Verify x402 payment on Stellar
    const isValid = await verifyX402Payment(paymentToken, String(playbook.price), expectedPayee);
    if (!isValid) {
      return Response.json({ error: "Invalid or insufficient payment" }, { status: 402 });
    }

    // Settle payment on-chain
    let txHash: string;
    try {
      const settled = await settleX402Payment(paymentToken);
      txHash = settled.txHash;
    } catch (err) {
      console.error("Playbook purchase settlement failed:", err);
      return Response.json({ error: "On-chain payment settlement failed" }, { status: 502 });
    }

    // Record purchase + revenue
    const [purchase] = await db
      .insert(tlsPlaybookPurchases)
      .values({ playbookId: id, buyerPublicKey, txHash })
      .returning();

    await db.insert(tlsRevenues).values({
      talosId: playbook.talosId,
      amount: playbook.price,
      currency: playbook.currency,
      source: "playbook_sale",
      txHash,
    });

    return Response.json(purchase, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
