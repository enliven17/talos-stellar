/**
 * POST /api/talos/:id/budgets/reconcile
 *
 * Rebuild the canonical available amount for a budget from the
 * reservation ledger + event log, compare it to the mirror column on
 * `tls_budgets.availableAmount`, and (by default) repair any drift
 * for non-rolling scopes.  Rolling scopes are always recomputed on
 * read so the mirror field is allowed to be stale.
 *
 * This endpoint is idempotent and safe to call at any cadence — use
 * it as an operational tool after incidents, restore-from-snapshot,
 * or scheduled ops jobs to keep the budget mirror honest.
 *
 * Body — see reconcileBudgetSchema in web/src/lib/schemas.ts:
 *   - budgetId: which budget to reconcile
 *   - dryRun:   if true, do not write; just report the diff
 */

import { NextRequest } from "next/server";

import {
  BudgetError,
  reconcileBudget,
} from "@/lib/budgets/budget-services";
import { verifyAgentApiKey } from "@/lib/auth";
import { withRequestId } from "@/lib/with-request-id";
import { parseBody, reconcileBudgetSchema } from "@/lib/schemas";
import { logger } from "@/lib/logger";

export const POST = withRequestId(async (request: NextRequest, ctx) => {
  const { id: talosId } = await ctx.params;

  const auth = await verifyAgentApiKey(request, talosId);
  if (!auth.ok) return auth.response;

  const parse = await parseBody(request, reconcileBudgetSchema);
  if (parse.error) return parse.error;

  try {
    const result = await reconcileBudget(
      talosId,
      parse.data!.budgetId,
      { dryRun: parse.data!.dryRun },
    );
    logger.info(
      {
        talosId,
        budgetId: result.budgetId,
        mismatched: result.mismatched,
        repaired: result.repaired,
      },
      "budget_reconcile_done",
    );
    return Response.json({ reconciliation: result }, { status: 200 });
  } catch (err) {
    if (err instanceof BudgetError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    logger.error({ err, talosId }, "budget_reconcile_failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});
