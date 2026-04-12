import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsRevenues } from "@/db/schema";
import { eq, and, sum } from "drizzle-orm";

/**
 * POST /api/talos/:id/revenue/distribute
 *
 * Distribute accumulated treasury USDC to Mitos holders proportionally.
 * Requires STELLAR_OPERATOR_SECRET_KEY (operator holds agent treasury for now).
 *
 * Body: { requesterPublicKey } — must be creator or operator
 *
 * Returns: list of transfers executed
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { requesterPublicKey } = body as { requesterPublicKey?: string };

    if (!requesterPublicKey) {
      return Response.json({ error: "requesterPublicKey is required" }, { status: 400 });
    }

    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    // Only creator or operator can distribute
    const OPERATOR = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";
    if (requesterPublicKey !== talos.creatorPublicKey && requesterPublicKey !== OPERATOR) {
      return Response.json({ error: "Only the creator or operator can trigger distribution" }, { status: 403 });
    }

    // Calculate total revenue
    const revenueResult = await db
      .select({ total: sum(tlsRevenues.amount) })
      .from(tlsRevenues)
      .where(eq(tlsRevenues.talosId, id));
    const totalRevenue = parseFloat(revenueResult[0]?.total ?? "0");

    if (totalRevenue <= 0) {
      return Response.json({ error: "No revenue to distribute" }, { status: 400 });
    }

    // Get all active patrons
    const patrons = await db
      .select()
      .from(tlsPatrons)
      .where(and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.status, "active")));

    if (patrons.length === 0) {
      return Response.json({ error: "No active patrons to distribute to" }, { status: 400 });
    }

    const totalPulse = patrons.reduce((s, p) => s + p.pulseAmount, 0);
    if (totalPulse === 0) {
      return Response.json({ error: "Total Mitos held by patrons is 0" }, { status: 400 });
    }

    // investorShare % goes to patrons, rest stays in treasury
    const investorShare = talos.investorShare ?? 25; // default 25%
    const distributableAmount = (totalRevenue * investorShare) / 100;

    const operatorSecret = process.env.STELLAR_OPERATOR_SECRET_KEY;
    if (!operatorSecret) {
      return Response.json({ error: "STELLAR_OPERATOR_SECRET_KEY not configured" }, { status: 500 });
    }

    const {
      Keypair, Asset, TransactionBuilder, Operation, BASE_FEE, Networks, Horizon,
    } = await import("@stellar/stellar-sdk");

    const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const usdc = new Asset("USDC", USDC_ISSUER);
    const operatorKeypair = Keypair.fromSecret(operatorSecret);
    const server = new Horizon.Server("https://horizon-testnet.stellar.org");

    const transfers: { patron: string; amount: number; txHash: string }[] = [];
    const errors: { patron: string; error: string }[] = [];

    for (const patron of patrons) {
      const shareRatio = patron.pulseAmount / totalPulse;
      const patronAmount = Math.floor(distributableAmount * shareRatio * 1e7) / 1e7;

      if (patronAmount < 0.0000001) continue; // Skip dust

      try {
        const operatorAccount = await server.loadAccount(operatorKeypair.publicKey());
        const tx = new TransactionBuilder(operatorAccount, {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(Operation.payment({
            destination: patron.stellarPublicKey,
            asset: usdc,
            amount: patronAmount.toFixed(7),
          }))
          .setTimeout(60)
          .build();
        tx.sign(operatorKeypair);
        const result = await server.submitTransaction(tx);
        transfers.push({ patron: patron.stellarPublicKey, amount: patronAmount, txHash: result.hash });
      } catch (err: any) {
        errors.push({
          patron: patron.stellarPublicKey,
          error: err?.response?.data?.extras?.result_codes?.operations?.[0] ?? err?.message ?? "unknown",
        });
      }
    }

    return Response.json({
      success: true,
      totalRevenue,
      distributableAmount,
      investorSharePercent: investorShare,
      transfers,
      errors,
      message: `Distributed ${distributableAmount.toFixed(2)} USDC (${investorShare}% of ${totalRevenue.toFixed(2)} USDC treasury) to ${transfers.length} patrons`,
    });
  } catch (err) {
    console.error("[revenue/distribute]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * GET /api/talos/:id/revenue/distribute
 * Preview distribution without executing
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    const [revenueResult, patrons] = await Promise.all([
      db.select({ total: sum(tlsRevenues.amount) }).from(tlsRevenues).where(eq(tlsRevenues.talosId, id)),
      db.select().from(tlsPatrons).where(and(eq(tlsPatrons.talosId, id), eq(tlsPatrons.status, "active"))),
    ]);

    const totalRevenue = parseFloat(revenueResult[0]?.total ?? "0");
    const investorShare = talos.investorShare ?? 25;
    const distributableAmount = (totalRevenue * investorShare) / 100;
    const totalPulse = patrons.reduce((s, p) => s + p.pulseAmount, 0);

    const breakdown = patrons.map((p) => ({
      stellarPublicKey: p.stellarPublicKey,
      pulseAmount: p.pulseAmount,
      sharePercent: totalPulse > 0 ? ((p.pulseAmount / totalPulse) * 100).toFixed(2) : "0",
      estimatedUsdc: totalPulse > 0
        ? ((distributableAmount * p.pulseAmount) / totalPulse).toFixed(6)
        : "0",
    }));

    return Response.json({
      totalRevenue,
      distributableAmount,
      investorSharePercent: investorShare,
      treasuryRetained: totalRevenue - distributableAmount,
      breakdown,
    });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
