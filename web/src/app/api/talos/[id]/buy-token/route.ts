import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsRevenues } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAccountInfo } from "@/lib/stellar";

/**
 * Buy Pulse tokens from a Talos.
 * 
 * Flow:
 * 1. Verify buyer's Stellar account exists
 * 2. Calculate total cost (amount * pricePerToken)
 * 3. Check if buyer has sufficient USDC balance
 * 4. Record the purchase in DB
 * 5. Return txHash placeholder (real transfer initiated client-side via wallet)
 *
 * Note: The actual USDC transfer is initiated by the buyer's wallet
 * before calling this endpoint. This endpoint verifies the buyer has
 * the funds and records the token purchase.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  const { buyerPublicKey, amount, txHash } = body as {
    buyerPublicKey?: string;
    amount?: number;
    txHash?: string;
  };

  if (!buyerPublicKey || typeof buyerPublicKey !== "string") {
    return NextResponse.json({ error: "buyerPublicKey is required" }, { status: 400 });
  }
  if (!amount || typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  const talos = await db.query.tlsTalos.findFirst({
    where: eq(tlsTalos.id, id),
  });

  if (!talos) {
    return NextResponse.json({ error: "TALOS not found" }, { status: 404 });
  }

  const pricePerToken = Number(talos.pulsePrice);
  if (pricePerToken <= 0) {
    return NextResponse.json({ error: "Token is not available for purchase" }, { status: 400 });
  }

  const totalCost = Math.round(amount * pricePerToken * 1e6) / 1e6;

  // Verify buyer's Stellar account exists and has sufficient USDC
  const accountInfo = await getAccountInfo(buyerPublicKey);
  if (!accountInfo.exists) {
    return NextResponse.json(
      { error: `Stellar account ${buyerPublicKey} does not exist` },
      { status: 400 },
    );
  }

  const buyerUsdc = parseFloat(accountInfo.usdcBalance);
  if (buyerUsdc < totalCost) {
    return NextResponse.json(
      {
        error: `Insufficient USDC balance. Need ${totalCost.toFixed(2)}, have ${buyerUsdc.toFixed(2)}`,
        required: totalCost,
        available: buyerUsdc,
      },
      { status: 400 },
    );
  }

  // Check if buyer is already a patron
  const existingPatron = await db.query.tlsPatrons.findFirst({
    where: and(
      eq(tlsPatrons.talosId, id),
      eq(tlsPatrons.stellarPublicKey, buyerPublicKey),
    ),
  });

  const currentPulseAmount = existingPatron?.pulseAmount ?? 0;
  const newPulseAmount = currentPulseAmount + amount;

  if (existingPatron) {
    // Update existing patron's pulse holding
    await db
      .update(tlsPatrons)
      .set({
        pulseAmount: newPulseAmount,
        updatedAt: new Date(),
      })
      .where(eq(tlsPatrons.id, existingPatron.id));
  } else {
    // Register as new patron
    await db.insert(tlsPatrons).values({
      talosId: id,
      stellarPublicKey: buyerPublicKey,
      role: "patron",
      share: "0",
      pulseAmount: newPulseAmount,
      status: "active",
    });
  }

  // Record revenue if txHash is provided (payment already executed)
  if (txHash) {
    await db.insert(tlsRevenues).values({
      talosId: id,
      amount: String(totalCost),
      currency: "USDC",
      source: "token_sale",
      txHash,
    });
  }

  return NextResponse.json({
    success: true,
    txHash: txHash || "pending_client_payment",
    tokenSymbol: talos.tokenSymbol ?? "MITOS",
    amount,
    pricePerToken,
    totalCost,
    currency: "USDC",
    buyerPublicKey,
    totalPulseHeld: newPulseAmount,
    patronStatus: existingPatron ? "updated" : "registered",
    message: txHash
      ? `Successfully purchased ${amount.toLocaleString()} ${talos.tokenSymbol ?? "PULSE"} for ${totalCost.toFixed(2)} USDC`
      : `Please transfer ${totalCost.toFixed(2)} USDC to ${talos.walletPublicKey} and confirm with txHash`,
  });
}
