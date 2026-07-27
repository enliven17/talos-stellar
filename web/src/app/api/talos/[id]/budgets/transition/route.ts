/**
 * POST /api/talos/:id/budgets/transition
 *
 * Move a reservation to a new state (committed → settled,
 * reserved → released, etc.).  All transitions are validated against
 * the state machine in web/src/lib/budgets/reconciliation.ts and
 * require the caller to send the current `fencingToken` so that
 * stale-worker writes cannot race past the lease.
 *
 * Body — see transitionReservationSchema in web/src/lib/schemas.ts:
 *   - reservationId: which reservation to transition
 *   - toStatus:      one of 'committed','settled','released','expired','refunded'
 *                   (the legal `from` for each target is enforced server-side)
 *   - fencingToken:  current fencing token; must equal the row's value
 *   - reason / txHash / metadata: optional audit info (never logged in full)
 */

import { NextRequest } from "next/server";

import {
  BudgetError,
  transitionReservation,
} from "@/lib/budgets/budget-services";
import { verifyAgentApiKey } from "@/lib/auth";
import { withRequestId } from "@/lib/with-request-id";
import {
  parseBody,
  transitionReservationSchema,
} from "@/lib/schemas";
import { logger } from "@/lib/logger";

export const POST = withRequestId(async (request: NextRequest, ctx) => {
  const { id: talosId } = await ctx.params;

  const auth = await verifyAgentApiKey(request, talosId);
  if (!auth.ok) return auth.response;

  const parse = await parseBody(request, transitionReservationSchema);
  if (parse.error) return parse.error;

  try {
    const reservation = await transitionReservation({
      talosId,
      reservationId: parse.data!.reservationId,
      toStatus: parse.data!.toStatus,
      fencingToken: parse.data!.fencingToken,
      reason: parse.data!.reason,
      txHash: parse.data!.txHash,
      metadata: parse.data!.metadata,
    });
    return Response.json({ reservation }, { status: 200 });
  } catch (err) {
    if (err instanceof BudgetError) {
      return Response.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    logger.error({ err, talosId }, "budget_transition_failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
});
