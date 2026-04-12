import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsRevenues } from "@/db/schema";
import { and, eq, sum } from "drizzle-orm";

/**
 * POST /api/talos/:id/revenue/buyback
 *
 * Treasury buyback: operator sends USDC from treasury to Mitos issuer,
 * which effectively burns the USDC (issuer account has no use for it),
 * and separately burns Mitos tokens by sending them back to their issuer.
 *
 * Simplified testnet model:
 * - Takes `usdcAmount` from operator (treasury)
 * - Burns `mitosAmount` Mitos tokens (sends to issuer = burn)
 * - Records as a treasury_buyback revenue event (negative = expense)
 *
 * Body: { requesterPublicKey, usdcAmount, mitosAmount }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { requesterPublicKey, usdcAmount, mitosAmount } = body as {
      requesterPublicKey?: string;
      usdcAmount?: number;
      mitosAmount?: number;
    };

    if (!requesterPublicKey) {
      return Response.json({ error: "requesterPublicKey is required" }, { status: 400 });
    }
    if (!usdcAmount || usdcAmount <= 0) {
      return Response.json({ error: "usdcAmount must be positive" }, { status: 400 });
    }
    if (!mitosAmount || mitosAmount <= 0) {
      return Response.json({ error: "mitosAmount must be positive" }, { status: 400 });
    }

    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    const OPERATOR = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";
    if (requesterPublicKey !== talos.creatorPublicKey && requesterPublicKey !== OPERATOR) {
      return Response.json({ error: "Only creator or operator can trigger buyback" }, { status: 403 });
    }

    const assetCode = talos.stellarAssetCode;
    if (!assetCode?.includes(":")) {
      return Response.json({ error: "No Mitos token configured for this TALOS" }, { status: 400 });
    }

    const operatorSecret = process.env.STELLAR_OPERATOR_SECRET_KEY;
    if (!operatorSecret) {
      return Response.json({ error: "STELLAR_OPERATOR_SECRET_KEY not configured" }, { status: 500 });
    }

    const [mitosCode, mitosIssuer] = assetCode.split(":");
    const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

    const {
      Keypair, Asset, TransactionBuilder, Operation, BASE_FEE, Networks, Horizon,
    } = await import("@stellar/stellar-sdk");

    const operatorKeypair = Keypair.fromSecret(operatorSecret);
    const server = new Horizon.Server("https://horizon-testnet.stellar.org");
    const account = await server.loadAccount(operatorKeypair.publicKey());

    const usdc = new Asset("USDC", USDC_ISSUER);
    const mitos = new Asset(mitosCode, mitosIssuer);

    // Build TX: send USDC to burn address (issuer) + burn Mitos (send to issuer)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      // Burn Mitos: send tokens back to issuer (issuer can't spend own tokens = effective burn)
      .addOperation(Operation.payment({
        destination: mitosIssuer,
        asset: mitos,
        amount: String(mitosAmount),
      }))
      .setTimeout(60)
      .build();

    tx.sign(operatorKeypair);
    const result = await server.submitTransaction(tx);
    const txHash = result.hash;

    // Record as negative revenue (treasury expense)
    await db.insert(tlsRevenues).values({
      talosId: id,
      amount: String(-usdcAmount),
      currency: "USDC",
      source: "buyback",
      txHash,
    });

    return Response.json({
      success: true,
      txHash,
      mitosBurned: mitosAmount,
      usdcSpent: usdcAmount,
      message: `Buyback: burned ${mitosAmount.toLocaleString()} ${mitosCode} tokens. tx: ${txHash.slice(0, 12)}...`,
    });
  } catch (err: any) {
    console.error("[buyback]", err?.response?.data ?? err?.message ?? err);
    return Response.json(
      { error: err?.response?.data?.extras?.result_codes?.operations?.[0] ?? err?.message ?? "Buyback failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/talos/:id/revenue/buyback
 * Preview: treasury balance + buyback stats
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    const [revenueResult, buybackResult] = await Promise.all([
      db.select({ total: sum(tlsRevenues.amount) }).from(tlsRevenues).where(eq(tlsRevenues.talosId, id)),
      db.select({ total: sum(tlsRevenues.amount) })
        .from(tlsRevenues)
        .where(and(eq(tlsRevenues.talosId, id), eq(tlsRevenues.source, "buyback"))),
    ]);

    const totalRevenue = parseFloat(revenueResult[0]?.total ?? "0");
    const totalBuyback = Math.abs(parseFloat(buybackResult[0]?.total ?? "0"));
    const treasuryShare = talos.treasuryShare ?? 15;
    const investorShare = talos.investorShare ?? 25;
    const treasuryBalance = (totalRevenue * treasuryShare) / 100;

    // Check on-chain Mitos balance of operator
    let operatorMitosBalance = 0;
    if (talos.stellarAssetCode?.includes(":")) {
      try {
        const [mitosCode, mitosIssuer] = talos.stellarAssetCode.split(":");
        const { Horizon } = await import("@stellar/stellar-sdk");
        const server = new Horizon.Server("https://horizon-testnet.stellar.org");
        const OPERATOR = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";
        const account = await server.loadAccount(OPERATOR);
        const balance = (account.balances as any[]).find(
          b => b.asset_code === mitosCode && b.asset_issuer === mitosIssuer,
        );
        operatorMitosBalance = parseFloat(balance?.balance ?? "0");
      } catch { /* offline */ }
    }

    return Response.json({
      totalRevenue,
      treasuryBalance,
      treasurySharePercent: treasuryShare,
      investorSharePercent: investorShare,
      totalBuybackExecuted: totalBuyback,
      operatorMitosBalance,
      tokenSymbol: talos.tokenSymbol ?? "MITOS",
      circulatingSupply: talos.totalSupply - operatorMitosBalance,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
