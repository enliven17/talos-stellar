/**
 * GET /api/admin/reconciler/plan
 *   Generates a dry-run payment repair plan with proposed state changes and
 *   supporting Horizon/ledger observations. Performs zero DB writes.
 *
 * POST /api/admin/reconciler/plan
 *   Executes ONLY an explicitly selected, unchanged payment repair plan.
 *   Body: { plan: PaymentRepairPlan, planHash: string, selectedRecordIds: string[] }
 *
 * Both endpoints require `Authorization: Bearer <ADMIN_API_KEY>`.
 */

import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import {
  createDryRunRepairPlan,
  executeRepairPlan,
  type PaymentRepairPlan,
} from "@/lib/reconciler";

export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const plan = await createDryRunRepairPlan();
    if (!plan) {
      return Response.json(
        { error: "Horizon unreachable — unable to build dry-run repair plan" },
        { status: 503 },
      );
    }

    return Response.json({ plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  try {
    const body = (await request.json().catch(() => null)) as {
      plan?: PaymentRepairPlan;
      planHash?: string;
      selectedRecordIds?: string[];
    } | null;

    if (!body || !body.plan || typeof body.planHash !== "string") {
      return Response.json(
        { error: "Request body must include plan, planHash, and selectedRecordIds" },
        { status: 400 },
      );
    }

    const result = await executeRepairPlan(body.plan, {
      planHash: body.planHash,
      selectedRecordIds: Array.isArray(body.selectedRecordIds)
        ? body.selectedRecordIds
        : [],
    });

    if (!result.ok) {
      const status =
        result.code === "INVALID_SELECTION" ? 400 : 409;
      return Response.json({ error: result.error, code: result.code, result }, { status });
    }

    return Response.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
