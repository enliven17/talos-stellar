import { db } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import { tlsTalos, tlsPatrons, tlsRevenues, tlsTokenPurchases } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getAccountInfo, getNetworkPassphrase, getUSDCIssuer } from "@/lib/stellar";
import { OPERATOR_PUBLIC_KEY } from "@/lib/stellar-config";

/**
 * Buy Mitos tokens from a Talos.
 *
 * Idempotency contract
 * ────────────────────
 * The Stellar txHash supplied by the caller is used as the idempotency key.
 * Before any side effects are executed we INSERT a row into tls_token_purchases
 * with status="pending". The txHash PRIMARY KEY makes that INSERT fail for any
 * concurrent or duplicate request, which returns 409 immediately.
 *
 * After the on-chain transfer succeeds, a single db.transaction() atomically:
 *   1. upserts the patron record
 *   2. inserts the revenue record
 *   3. flips the purchase row to status="completed" with a cached responseBody
 *
 * A retry of a completed purchase receives the original 200 response from the
 * cache — no side effects are repeated.
 *
 * Flow:
 * 1. Validate request body
 * 2. Fetch Talos, compute cost
 * 3. INSERT pending idempotency row (blocks concurrent dupes)
 * 4. Verify Stellar txHash on Horizon
 * 5. Send Mitos tokens from operator to buyer
 * 6. Commit side effects in a single DB transaction (patron upsert + revenue
 *    insert + purchase status=completed + cached response)
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

  // ── Talos lookup ─────────────────────────────────────────────────
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

  // ── Idempotency check / claim ─────────────────────────────────────
  // Look up an existing purchase record first.
  const existing = await db.query.tlsTokenPurchases.findFirst({
    where: eq(tlsTokenPurchases.txHash, txHash),
  });

  if (existing) {
    if (existing.status === "completed" && existing.responseBody) {
      // Idempotent replay — return original response
      return NextResponse.json(existing.responseBody, { status: 200 });
    }
    if (existing.status === "pending") {
      return NextResponse.json(
        { error: "Purchase is already in progress for this transaction" },
        { status: 409 },
      );
    }
    // "failed" — fall through and retry (row will be updated below)
  }

  // Claim the idempotency slot. For a brand-new request we insert a pending
  // row; for a retry of a failed request we update it back to pending.
  try {
    if (!existing) {
      await db.insert(tlsTokenPurchases).values({
        txHash,
        talosId: id,
        buyerPublicKey,
        amount,
        totalCost: String(totalCost),
        status: "pending",
      });
    } else {
      // Retry of a failed purchase — reset to pending
      await db
        .update(tlsTokenPurchases)
        .set({ status: "pending", responseBody: null, updatedAt: new Date() })
        .where(eq(tlsTokenPurchases.txHash, txHash));
    }
  } catch (err: any) {
    // Unique constraint violation → another concurrent request already claimed
    // this txHash (race condition: two requests arrived simultaneously before
    // either read the existing row).
    if (err?.code === "23505") {
      return NextResponse.json(
        { error: "Purchase is already in progress for this transaction" },
        { status: 409 },
      );
    }
    throw err;
  }

  // ── Horizon Transaction Verification ─────────────────────────────
  let txResult;
  try {
    const { Horizon } = await import("@stellar/stellar-sdk");
    const server = new Horizon.Server(process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org");
    txResult = await server.transactions().transaction(txHash).call();
  } catch (err: any) {
    console.error("[buy-token] Transaction fetch failed:", err?.message ?? err);
    // Mark failed so a later retry (with a corrected txHash) can proceed
    await db
      .update(tlsTokenPurchases)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tlsTokenPurchases.txHash, txHash));
    return NextResponse.json({ error: "Transaction not found on Stellar network" }, { status: 400 });
  }

  if (!txResult.successful) {
    await db
      .update(tlsTokenPurchases)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tlsTokenPurchases.txHash, txHash));
    return NextResponse.json({ error: "Transaction was not successful on-chain" }, { status: 400 });
  }

  try {
    const { TransactionBuilder, Asset } = await import("@stellar/stellar-sdk");
    const networkPassphrase = getNetworkPassphrase();
    const usdcIssuer = getUSDCIssuer();
    const usdcAsset = new Asset("USDC", usdcIssuer);

    const tx = TransactionBuilder.fromXDR(txResult.envelope_xdr, networkPassphrase);
    const innerTx = "innerTransaction" in tx ? tx.innerTransaction : tx;

    if (
      innerTx.source !== buyerPublicKey &&
      txResult.source_account !== buyerPublicKey
    ) {
      await db
        .update(tlsTokenPurchases)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(tlsTokenPurchases.txHash, txHash));
      return NextResponse.json(
        { error: "Transaction signer does not match buyerPublicKey" },
        { status: 400 },
      );
    }

    const ops = innerTx.operations as unknown as Array<{
      type: string;
      asset?: { code: string; issuer: string };
      destination?: string;
      amount?: string;
    }>;

    const expectedDestinations = [OPERATOR_PUBLIC_KEY];
    if (talos.agentWalletAddress) {
      expectedDestinations.push(talos.agentWalletAddress);
    }

    const hasValidPayment = ops.some(
      (op) =>
        op.type === "payment" &&
        op.asset?.code === usdcAsset.code &&
        op.asset?.issuer === usdcAsset.issuer &&
        expectedDestinations.includes(op.destination ?? "") &&
        Math.abs(parseFloat(op.amount ?? "0") - totalCost) <= 1e-6,
    );

    if (!hasValidPayment) {
      await db
        .update(tlsTokenPurchases)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(tlsTokenPurchases.txHash, txHash));
      return NextResponse.json(
        { error: "No matching USDC payment found in transaction" },
        { status: 400 },
      );
    }
  } catch (err: any) {
    console.error("[buy-token] Transaction verification failed:", err?.message ?? err);
    await db
      .update(tlsTokenPurchases)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tlsTokenPurchases.txHash, txHash));
    return NextResponse.json({ error: "Failed to verify transaction details" }, { status: 400 });
  }

  // ── Verify buyer account exists on Stellar ────────────────────────
  const accountInfo = await getAccountInfo(buyerPublicKey);
  if (!accountInfo.exists) {
    await db
      .update(tlsTokenPurchases)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(tlsTokenPurchases.txHash, txHash));
    return NextResponse.json(
      { error: `Stellar account ${buyerPublicKey} does not exist` },
      { status: 400 },
    );
  }

  // ── Send Mitos tokens from operator to buyer ──────────────────────
  let mitosTxHash: string | null = null;
  const assetCode = talos.stellarAssetCode;

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
      await db
        .update(tlsTokenPurchases)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(tlsTokenPurchases.txHash, txHash));
      return NextResponse.json(
        { error: "Failed to send Mitos tokens to buyer. Purchase cancelled." },
        { status: 500 },
      );
    }
  }

  // ── Patron threshold check (pre-compute outside transaction) ──────
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

  const tokenSymbol = talos.tokenSymbol ?? "MITOS";

  const responseBody = {
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
  };

  // ── Atomic side-effects transaction ──────────────────────────────
  // All DB writes — patron upsert, revenue insert, and the idempotency row
  // flip to "completed" — are committed in one transaction. A crash before
  // commit rolls back every write; the purchase row stays "pending" and the
  // next retry can proceed safely.
  await withTransactionRetry(
    async (tx) => {
      // 1. Patron upsert
      if (becomesPatron) {
        if (existingPatron) {
          await tx
            .update(tlsPatrons)
            .set({ pulseAmount: newPulseAmount, updatedAt: new Date() })
            .where(eq(tlsPatrons.id, existingPatron.id));
        } else {
          await tx.insert(tlsPatrons).values({
            talosId: id,
            stellarPublicKey: buyerPublicKey,
            role: "patron",
            share: "0",
            pulseAmount: newPulseAmount,
            status: "active",
          });
        }
      } else if (existingPatron) {
        await tx
          .update(tlsPatrons)
          .set({ pulseAmount: newPulseAmount, updatedAt: new Date() })
          .where(eq(tlsPatrons.id, existingPatron.id));
      }

      // 2. Revenue record
      await tx.insert(tlsRevenues).values({
        talosId: id,
        amount: String(totalCost),
        currency: "USDC",
        source: "token_sale",
        txHash,
      });

      // 3. Flip idempotency row to completed with cached response
      await tx
        .update(tlsTokenPurchases)
        .set({
          status: "completed",
          responseBody,
          updatedAt: new Date(),
        })
        .where(eq(tlsTokenPurchases.txHash, txHash));
    },
    { category: "TOKEN" }
  );

  return NextResponse.json(responseBody);
}
