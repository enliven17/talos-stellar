import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsRevenues } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAccountInfo } from "@/lib/stellar";

/**
 * Buy Mitos tokens from a Talos.
 *
 * Flow:
 * 1. Verify buyer's Stellar account exists
 * 2. Calculate total cost (amount * pricePerToken)
 * 3. Check if buyer has sufficient USDC balance
 * 4. Verify txHash is present (USDC payment already submitted by client)
 * 5. Send Mitos tokens from operator to buyer (server-side)
 * 6. Record patron status if buyer meets minimum threshold
 * 7. Record revenue
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
  if (!txHash) {
    return NextResponse.json({ error: "txHash is required — submit USDC payment first" }, { status: 400 });
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

  // Verify buyer's Stellar account exists
  const accountInfo = await getAccountInfo(buyerPublicKey);
  if (!accountInfo.exists) {
    return NextResponse.json(
      { error: `Stellar account ${buyerPublicKey} does not exist` },
      { status: 400 },
    );
  }

  // ── Send Mitos tokens from operator to buyer ───────────────────────
  let mitosTxHash: string | null = null;
  const assetCode = talos.stellarAssetCode; // format: "SYMBOL:ISSUER"

  if (assetCode && assetCode.includes(":")) {
    try {
      const [mitosCode, mitosIssuer] = assetCode.split(":");
      const operatorSecret = process.env.STELLAR_OPERATOR_SECRET_KEY;

      if (operatorSecret) {
        const {
          Keypair,
          Asset,
          TransactionBuilder,
          Operation,
          BASE_FEE,
          Networks,
          Horizon,
        } = await import("@stellar/stellar-sdk");

        const operatorKeypair = Keypair.fromSecret(operatorSecret);
        const server = new Horizon.Server("https://horizon-testnet.stellar.org");
        const operatorAccount = await server.loadAccount(operatorKeypair.publicKey());
        const mitosAsset = new Asset(mitosCode, mitosIssuer);

        const mitosTx = new TransactionBuilder(operatorAccount, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.payment({
              destination: buyerPublicKey,
              asset: mitosAsset,
              amount: String(amount),
            }),
          )
          .setTimeout(60)
          .build();

        mitosTx.sign(operatorKeypair);
        const mitosTxResult = await server.submitTransaction(mitosTx);
        mitosTxHash = mitosTxResult.hash;
      }
    } catch (err: any) {
      console.error("[buy-token] Mitos transfer failed:", err?.response?.data ?? err?.message ?? err);
      return NextResponse.json(
        { error: "Failed to send Mitos tokens to buyer. Purchase cancelled." },
        { status: 500 },
      );
    }
  }

  // ── Patron threshold check ─────────────────────────────────────────
  const minForPatron = talos.minPatronPulse ?? 100;

  const existingPatron = await db.query.tlsPatrons.findFirst({
    where: and(
      eq(tlsPatrons.talosId, id),
      eq(tlsPatrons.stellarPublicKey, buyerPublicKey),
    ),
  });

  const currentPulseAmount = existingPatron?.pulseAmount ?? 0;
  const newPulseAmount = currentPulseAmount + amount;
  const becomesPatron = newPulseAmount >= minForPatron;

  if (becomesPatron) {
    if (existingPatron) {
      await db
        .update(tlsPatrons)
        .set({ pulseAmount: newPulseAmount, updatedAt: new Date() })
        .where(eq(tlsPatrons.id, existingPatron.id));
    } else {
      await db.insert(tlsPatrons).values({
        talosId: id,
        stellarPublicKey: buyerPublicKey,
        role: "patron",
        share: "0",
        pulseAmount: newPulseAmount,
        status: "active",
      });
    }
  } else if (existingPatron) {
    // Update token balance even if still below threshold
    await db
      .update(tlsPatrons)
      .set({ pulseAmount: newPulseAmount, updatedAt: new Date() })
      .where(eq(tlsPatrons.id, existingPatron.id));
  }

  // ── Record revenue ─────────────────────────────────────────────────
  await db.insert(tlsRevenues).values({
    talosId: id,
    amount: String(totalCost),
    currency: "USDC",
    source: "token_sale",
    txHash,
  });

  const tokenSymbol = talos.tokenSymbol ?? "MITOS";

  return NextResponse.json({
    success: true,
    txHash,
    mitosTxHash,
    tokenSymbol,
    amount,
    pricePerToken,
    totalCost,
    currency: "USDC",
    buyerPublicKey,
    totalPulseHeld: newPulseAmount,
    patronStatus: becomesPatron
      ? existingPatron
        ? "updated"
        : "registered"
      : newPulseAmount < minForPatron
        ? `pending (need ${minForPatron - newPulseAmount} more ${tokenSymbol})`
        : "active",
    message: `Successfully purchased ${amount.toLocaleString()} ${tokenSymbol} for ${totalCost.toFixed(2)} USDC`,
  });
}
