import { withRequestId } from "@/lib/with-request-id";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { withTransactionRetry } from "@/db/db-retry";
import { tlsTalos, tlsRevenues, tlsBuybackRequests } from "@/db/schema";
import { and, eq, sum } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { OPERATOR_PUBLIC_KEY } from "@/lib/stellar-config";
import { errorResponse } from "@/lib/api-response";
import { parseBody, buybackSchema, idempotencyKeySchema, formatValidationIssues } from "@/lib/schemas";


/**
 * POST /api/talos/:id/revenue/buyback
 *
 * Treasury buyback: operator sends USDC from treasury to Mitos issuer,
 * which effectively burns the USDC, and separately burns Mitos tokens
 * by sending them back to their issuer.
 *
 * Auth: Bearer token with revenue:write scope (scoped key or legacy).
 *
 * Validation: body is parsed with `buybackSchema` (positive, finite numbers,
 * max 7 decimals). Malformed JSON, strings, NaN and negatives return 400.
 *
 * Idempotency: send an optional `Idempotency-Key` header. A row is claimed in
 * `tls_buyback_requests` BEFORE the on-chain transfer, so:
 *   - replaying a completed key returns the original response, no new transfer
 *   - a concurrent / in-flight duplicate returns 409
 *   - reusing a key with different amounts returns 422
 *   - a transfer Horizon rejected is marked "failed" and may be retried; an
 *     ambiguous failure (e.g. timeout) stays "pending" so it can never be
 *     double-submitted.
 */
async function _POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["revenue:write"]);
    if (!auth.ok) return auth.response;

    const { data, error } = await parseBody(request, buybackSchema);
    if (error) return error;
    const { usdcAmount, mitosAmount } = data;

    // ── Idempotency-Key header (optional) ──────────────────────────
    let idempotencyKey: string | null = null;
    const rawKey = request.headers.get("idempotency-key");
    if (rawKey !== null) {
      const parsedKey = idempotencyKeySchema.safeParse(rawKey);
      if (!parsedKey.success) {
        return errorResponse(
          request,
          400,
          "VALIDATION_ERROR",
          "Validation failed",
          formatValidationIssues(parsedKey.error.issues),
        );
      }
      idempotencyKey = parsedKey.data;
    }
    const requestHash = createHash("sha256")
      .update(`${usdcAmount}:${mitosAmount}`)
      .digest("hex");

    const talos = await db.query.tlsTalos.findFirst({ where: eq(tlsTalos.id, id) });
    if (!talos) return Response.json({ error: "TALOS not found" }, { status: 404 });

    const assetCode = talos.stellarAssetCode;
    if (!assetCode?.includes(":")) {
      return Response.json({ error: "No Mitos token configured for this TALOS" }, { status: 400 });
    }

    const operatorSecret = process.env.STELLAR_OPERATOR_SECRET_KEY;
    if (!operatorSecret) {
      return Response.json({ error: "STELLAR_OPERATOR_SECRET_KEY not configured" }, { status: 500 });
    }

    // ── Idempotency check / claim ──────────────────────────────────
    if (idempotencyKey) {
      const existing = await db.query.tlsBuybackRequests.findFirst({
        where: and(
          eq(tlsBuybackRequests.talosId, id),
          eq(tlsBuybackRequests.idempotencyKey, idempotencyKey),
        ),
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          return Response.json(
            { error: "Idempotency-Key was already used with a different request body" },
            { status: 422 },
          );
        }
        if (existing.status === "completed" && existing.responseBody) {
          const replay = Response.json(existing.responseBody, { status: 200 });
          replay.headers.set("Idempotency-Key", idempotencyKey);
          replay.headers.set("X-Idempotent-Replayed", "true");
          return replay;
        }
        if (existing.status === "pending") {
          return Response.json(
            { error: "A buyback is already in progress for this Idempotency-Key" },
            { status: 409 },
          );
        }
        // "failed" — the transfer was rejected, so it is safe to retry.
      }

      try {
        if (!existing) {
          await db.insert(tlsBuybackRequests).values({
            talosId: id,
            idempotencyKey,
            requestHash,
            status: "pending",
          });
        } else {
          await db
            .update(tlsBuybackRequests)
            .set({ status: "pending", responseBody: null, updatedAt: new Date() })
            .where(and(
              eq(tlsBuybackRequests.talosId, id),
              eq(tlsBuybackRequests.idempotencyKey, idempotencyKey),
            ));
        }
      } catch (err: unknown) {
        // Unique violation: a concurrent request claimed this key first.
        if ((err as { code?: string }).code === "23505") {
          return Response.json(
            { error: "A buyback is already in progress for this Idempotency-Key" },
            { status: 409 },
          );
        }
        throw err;
      }
    }

    const [mitosCode, mitosIssuer] = assetCode.split(":");
    const {
      Keypair, Asset, TransactionBuilder, Operation, BASE_FEE, Networks, Horizon,
    } = await import("@stellar/stellar-sdk");

    const operatorKeypair = Keypair.fromSecret(operatorSecret);
    const server = new Horizon.Server("https://horizon-testnet.stellar.org");

    let txHash: string;
    try {
      const account = await server.loadAccount(operatorKeypair.publicKey());

      const _mitos = new Asset(mitosCode, mitosIssuer);

      // Build TX: send USDC to burn address (issuer) + burn Mitos (send to issuer)
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        // Burn Mitos: send tokens back to issuer (issuer can't spend own tokens = effective burn)
        .addOperation(Operation.payment({
          destination: mitosIssuer,
          asset: _mitos,
          amount: String(mitosAmount),
        }))
        .setTimeout(60)
        .build();

      tx.sign(operatorKeypair);
      const result = await server.submitTransaction(tx);
      txHash = result.hash;
    } catch (err: unknown) {
      // Only a definitive Horizon rejection proves no transfer happened.
      // Anything else (timeout, network drop) is ambiguous: leave the row
      // "pending" so a retry returns 409 instead of risking a second transfer.
      if (idempotencyKey && (err as { response?: unknown }).response) {
        await db
          .update(tlsBuybackRequests)
          .set({ status: "failed", updatedAt: new Date() })
          .where(and(
            eq(tlsBuybackRequests.talosId, id),
            eq(tlsBuybackRequests.idempotencyKey, idempotencyKey),
          ));
      }
      throw err;
    }

    const responseBody = {
      success: true,
      txHash,
      mitosBurned: mitosAmount,
      usdcSpent: usdcAmount,
      message: `Buyback: burned ${mitosAmount.toLocaleString()} ${mitosCode} tokens. tx: ${txHash.slice(0, 12)}...`,
    };

    // Record as negative revenue (treasury expense) and, when keyed, flip the
    // idempotency row to completed with the cached response — atomically.
    await withTransactionRetry(
      async (tx) => {
        await tx.insert(tlsRevenues).values({
          talosId: id,
          amount: String(-usdcAmount),
          currency: "USDC",
          source: "buyback",
          txHash,
        });
        if (idempotencyKey) {
          await tx
            .update(tlsBuybackRequests)
            .set({ status: "completed", responseBody, updatedAt: new Date() })
            .where(and(
              eq(tlsBuybackRequests.talosId, id),
              eq(tlsBuybackRequests.idempotencyKey, idempotencyKey),
            ));
        }
      },
      { category: "MONEY" }
    );

    const res = Response.json(responseBody);
    if (idempotencyKey) {
      res.headers.set("Idempotency-Key", idempotencyKey);
      res.headers.set("X-Idempotent-Replayed", "false");
    }
    return res;
  } catch (err: unknown) {
    const e = err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } }; message?: string };
    console.error("[buyback]", e.response?.data ?? e.message ?? err);
    return Response.json(
      { error: e.response?.data?.extras?.result_codes?.operations?.[0] ?? e.message ?? "Buyback failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/talos/:id/revenue/buyback
 * Preview: treasury balance + buyback stats
 */
async function _GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["revenue:read"]);
    if (!auth.ok) return auth.response;

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
        const account = await server.loadAccount(OPERATOR_PUBLIC_KEY);
        const balance = (account.balances as Array<{ asset_code?: string; asset_issuer?: string; balance?: string }>).find(
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

export const POST = withRequestId(_POST);
export const GET = withRequestId(_GET);
