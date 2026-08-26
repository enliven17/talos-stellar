import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsPatrons, tlsRevenues, tlsDividends } from "@/db/schema";
import { eq, and, sum } from "drizzle-orm";
import { OPERATOR_PUBLIC_KEY, USDC_ISSUER } from "@/lib/stellar-config";
import { createId } from "@paralleldrive/cuid2";
import { withTraceContext } from "@/lib/tracing";


/**
 * POST /api/talos/:id/revenue/distribute
 *
 * Distribute accumulated treasury USDC to Mitos holders proportionally.
 * Requires STELLAR_OPERATOR_SECRET_KEY (operator holds agent treasury for now).
 *
 * Auth: Bearer token with revenue:write scope (scoped key or legacy).
 */
async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { requesterPublicKey, distributionId } = body as { requesterPublicKey?: string; distributionId?: string };

    if (!requesterPublicKey) {
      return Response.json({ error: "requesterPublicKey is required" }, { status: 400 });
    }

    // Generate distributionId if not provided for idempotency
    const effectiveDistributionId = distributionId || createId();

    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    // Check for existing distribution with same id (idempotency)
    const existingDistribution = await db.query.tlsDividends.findFirst({
      where: and(eq(tlsDividends.talosId, id), eq(tlsDividends.distributionId, effectiveDistributionId)),
    });

    if (existingDistribution) {
      return Response.json({
        success: true,
        dividendId: existingDistribution.id,
        message: "Distribution already executed (idempotent)",
        status: existingDistribution.status,
        transfers: existingDistribution.breakdown || [],
      });
    }

    // Only creator or operator can distribute
    const OPERATOR = OPERATOR_PUBLIC_KEY;
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

    const USDC_ISSUER_VAL = USDC_ISSUER;
    const usdc = new Asset("USDC", USDC_ISSUER_VAL);
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
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : "unknown";
        const responseError = (err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } })?.response?.data?.extras?.result_codes?.operations?.[0];
        errors.push({
          patron: patron.stellarPublicKey,
          error: responseError ?? errorMessage ?? "unknown",
        });
      }
    }

    // Persist a dividend distribution history record within a transaction
    // to ensure atomicity of state transitions and distribution records
    const distributedTotal = transfers.reduce((s, t) => s + t.amount, 0);
    let dividendId: string | null = null;
    
    if (transfers.length > 0 && distributedTotal > 0) {
      try {
        await db.transaction(async (tx) => {
          const [dividend] = await tx
            .insert(tlsDividends)
            .values({
              talosId: id,
              amount: distributedTotal.toFixed(6),
              currency: "USDC",
              patronCount: transfers.length,
              totalPulse,
              source: "revenue-share",
              txHash: transfers[0]?.txHash ?? null,
              breakdown: transfers,
              status: errors.length > 0 ? "partial" : "completed",
              distributionId: effectiveDistributionId,
              retryCount: 0,
              retryable: true,
            })
            .returning({ id: tlsDividends.id });
          dividendId = dividend?.id ?? null;
        });
      } catch (logErr: unknown) {
        console.error("[revenue/distribute] failed to record dividend history", logErr);
        // Attempt to record as failed for retry tracking
        try {
          const errorMessage = logErr instanceof Error ? logErr.message : "Unknown recording error";
          await db.insert(tlsDividends).values({
            talosId: id,
            amount: "0",
            currency: "USDC",
            patronCount: 0,
            totalPulse,
            source: "revenue-share",
            txHash: null,
            breakdown: [],
            status: "failed",
            distributionId: effectiveDistributionId,
            retryCount: 1,
            lastError: errorMessage,
            retryable: true,
          });
        } catch (retryErr) {
          console.error("[revenue/distribute] failed to record failure state", retryErr);
        }
      }
    } else if (errors.length > 0) {
      // All transfers failed - record failed state for retry
      try {
        await db.insert(tlsDividends).values({
          talosId: id,
          amount: "0",
          currency: "USDC",
          patronCount: 0,
          totalPulse,
          source: "revenue-share",
          txHash: null,
          breakdown: [],
          status: "failed",
          distributionId: effectiveDistributionId,
          retryCount: 1,
          lastError: errors.map(e => e.error).join(", "),
          retryable: true,
        });
      } catch (logErr) {
        console.error("[revenue/distribute] failed to record failure state", logErr);
      }
    }

    return Response.json({
      success: true,
      dividendId,
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
async function handleGet(
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

export const POST = withTraceContext(handlePost);
export const GET = withTraceContext(handleGet);
