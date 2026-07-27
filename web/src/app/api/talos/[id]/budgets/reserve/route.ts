/**
 * POST /api/talos/:id/budgets/reserve
 *
 * Atomically reserve minor-unit spend against one of the agent's
 * budget scopes.  Idempotent on `Idempotency-Key` (scoped per talosId).
 * Returns the durable reservation record.
 *
 * Request body — see reserveBudgetSchema in web/src/lib/schemas.ts:
 *   - scopeKind: 'global' | 'rolling' | 'category' | 'asset' |
 *                'transaction' | 'counterparty'
 *   - scopeValue: NULL for global, the bucket name otherwise
 *   - amountMinor: positive integer in minor units (≤ 9.2e18)
 *   - expiresInSeconds: optional, default 3600 (1h), max 30d
 *   - counterpartyId/category/assetCode: optional scope refs for
 *                accounting against category/asset/counterparty scopes
 *   - txHash/jobId: optional links to upstream evidence
 *   - metadata: optional structured free-form payload (never logged)
 *
 * Responses:
 *   201 Created     — reservation durable, returns { reservation }
 *   400 Validation — malformed body
 *   401/403         — auth header missing / wrong / wrong talos
 *   404             — no matching budget row exists
 *   409 Conflict    — insufficient budget | disabled | idempotency
 *                     conflict | another reservation is racing
 *   500             — internal error (cover by Sentry)
 */

import { NextRequest } from "next/server";

import { BudgetError, reserveBudget } from "@/lib/budgets/budget-services";
import { verifyAgentApiKey } from "@/lib/auth";
import { withRequestId } from "@/lib/with-request-id";
import { parseBody, reserveBudgetSchema, ScopeKind } from "@/lib/schemas";
import { logger } from "@/lib/logger";

export const POST = withRequestId(async (request: NextRequest, ctx) => {
  const { id: talosId } = await ctx.params;

  const auth = await verifyAgentApiKey(request, talosId);
  if (!auth.ok) return auth.response;

  const parse = await parseBody(request, reserveBudgetSchema);
  if (parse.error) return parse.error;

  const idempotencyKey =
    request.headers.get("Idempotency-Key")?.trim() || undefined;

  try {
    const reservation = await reserveBudget({
      talosId,
      scopeKind: parse.data!.scopeKind as ScopeKind,
      scopeValue: parse.data!.scopeValue ?? null,
      amountMinor: BigInt(parse.data!.amountMinor),
      currency: parse.data!.currency,
      counterpartyId: parse.data!.counterpartyId,
      category: parse.data!.category,
      assetCode: parse.data!.assetCode,
      txHash: parse.data!.txHash,
      jobId: parse.data!.jobId,
      expiresInSeconds: parse.data!.expiresInSeconds,
      metadata: parse.data!.metadata,
      idempotencyKey,
    });
    return Response.json({ reservation }, { status: 201 });
  } catch (err) {
    if (err instanceof BudgetError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    logger.error({ err, talosId }, "budget_reserve_failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});
