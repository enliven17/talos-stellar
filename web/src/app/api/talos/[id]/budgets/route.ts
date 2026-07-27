/**
 * GET /api/talos/:id/budgets
 *   List every budget configured for the agent (all scopes).
 *
 * POST /api/talos/:id/budgets
 *   Create or upsert a budget configuration.  Body validated against
 *   the createBudgetSchema.  This is intentionally a privileged
 *   endpoint — agents/operators provision budgets during onboarding or
 *   policy updates.  Use the Authorization header so the talos ID in
 *   the URL must match the talos authenticated by the API key.
 */

import { NextRequest } from "next/server";

import {
  BudgetError,
  listBudgetsForAgent,
  upsertBudget,
} from "@/lib/budgets/budget-services";
import { verifyAgentApiKey } from "@/lib/auth";
import { withRequestId } from "@/lib/with-request-id";
import {
  createBudgetSchema,
  parseBody,
  ScopeKind,
} from "@/lib/schemas";
import { logger } from "@/lib/logger";

export const GET = withRequestId(async (request: NextRequest, ctx) => {
  const { id: talosId } = await ctx.params;

  const auth = await verifyAgentApiKey(request, talosId);
  if (!auth.ok) return auth.response;

  try {
    const budgets = await listBudgetsForAgent(talosId);
    return Response.json({ budgets }, { status: 200 });
  } catch (err) {
    logger.error({ err, talosId }, "budgets_list_failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});

export const POST = withRequestId(async (request: NextRequest, ctx) => {
  const { id: talosId } = await ctx.params;

  const auth = await verifyAgentApiKey(request, talosId);
  if (!auth.ok) return auth.response;

  const parse = await parseBody(request, createBudgetSchema);
  if (parse.error) return parse.error;

  try {
    const budget = await upsertBudget({
      talosId,
      scopeKind: parse.data!.scopeKind as ScopeKind,
      scopeValue: parse.data!.scopeValue ?? null,
      windowSeconds: parse.data!.windowSeconds ?? null,
      limitAmountMinor: BigInt(parse.data!.limitAmountMinor),
      currency: parse.data!.currency,
      enabled: parse.data!.enabled,
    });
    logger.info(
      {
        talosId,
        budgetId: budget.id,
        scopeKind: budget.scopeKind,
        scopeValue: budget.scopeValue,
      },
      "budget_upserted",
    );
    return Response.json({ budget }, { status: 200 });
  } catch (err) {
    if (err instanceof BudgetError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    logger.error({ err, talosId }, "budget_upsert_failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});
