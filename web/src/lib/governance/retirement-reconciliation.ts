/**
 * Retirement reconciliation: the bounded cleanup that must finish after a
 * retirement is approved and committed.
 *
 * This is not a second workflow engine. The cleanup is the existing durable
 * "retire" run in tls_provisioning_jobs (leases, fencing tokens, bounded
 * attempts, idempotent steps, restart recovery via findResumableJobs). This
 * module only:
 *   - enqueues that run atomically with the retirement, once per agent, and
 *   - summarises its progress (remaining steps, payout snapshot) for owners.
 */
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { tlsProvisioningJobs } from "@/db/schema";

import { LifecycleError } from "./lifecycle";
import { isDecimalAmount } from "./payout-obligations";
import {
  MAX_STEP_ATTEMPTS,
  RETIREMENT_STEP_NAMES,
  initialStepRecords,
  type StepRecord,
} from "./provisioning";

type WriteExecutor = Pick<typeof db, "select" | "insert">;
type ReadExecutor = Pick<typeof db, "select">;

/** One reconciliation run per agent: an agent retires once. */
export function retirementReconciliationKey(talosId: string): string {
  return "retire-reconcile:" + talosId;
}

/**
 * Create the run, or return the existing one. Safe inside a transaction: the
 * insert uses ON CONFLICT DO NOTHING, so a duplicate never aborts the caller's
 * transaction (a failed INSERT would poison it in Postgres).
 */
export async function enqueueRetirementReconciliation(
  executor: WriteExecutor,
  input: { talosId: string; requestedBy: string },
): Promise<{ jobId: string; created: boolean }> {
  const idempotencyKey = retirementReconciliationKey(input.talosId);
  const jobId = createId();

  const inserted = await executor
    .insert(tlsProvisioningJobs)
    .values({
      id: jobId,
      talosId: input.talosId,
      action: "retire",
      status: "pending",
      // Seeded up front so the remaining work is visible before a worker leases it.
      steps: initialStepRecords(jobId, RETIREMENT_STEP_NAMES),
      cursor: 0,
      requestedBy: input.requestedBy,
      idempotencyKey,
      maxAttempts: MAX_STEP_ATTEMPTS,
    })
    .onConflictDoNothing({
      target: [tlsProvisioningJobs.talosId, tlsProvisioningJobs.idempotencyKey],
    })
    .returning({ id: tlsProvisioningJobs.id });

  if (inserted[0]) return { jobId: inserted[0].id, created: true };

  const existing = await executor
    .select({ id: tlsProvisioningJobs.id })
    .from(tlsProvisioningJobs)
    .where(
      and(
        eq(tlsProvisioningJobs.talosId, input.talosId),
        eq(tlsProvisioningJobs.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (existing[0]) return { jobId: existing[0].id, created: false };

  throw new LifecycleError(
    "LIFECYCLE_CONFLICT",
    "Could not create the retirement reconciliation run; retry the request",
    { talosId: input.talosId },
  );
}

export interface RetirementReconciliationSummary {
  jobId: string;
  status: string;
  completedSteps: string[];
  /** Steps still to run, in execution order. Empty once the run completed. */
  remainingSteps: string[];
  failedStep: string | null;
  /** Unsettled payouts recorded by the snapshot step; null until it completes. */
  outstandingPayouts: Record<string, string> | null;
  completedAt: string | null;
}

interface SummaryRow {
  id: string;
  status: string;
  steps: unknown;
  completedAt: Date | string | null;
}

/**
 * Pure projection of a run row. Deliberately omits step error text, which is
 * operator-facing and may contain internal detail.
 */
export function summarizeRetirementReconciliation(row: SummaryRow): RetirementReconciliationSummary {
  const steps: StepRecord[] = Array.isArray(row.steps) ? (row.steps as StepRecord[]) : [];

  const completedSteps = steps.filter((s) => s.status === "completed").map((s) => s.name);
  const remainingSteps =
    steps.length > 0
      ? steps.filter((s) => s.status !== "completed").map((s) => s.name)
      : [...RETIREMENT_STEP_NAMES];

  const payout = steps.find((s) => s.name === "payout-obligations" && s.status === "completed");
  let outstandingPayouts: Record<string, string> | null = null;
  const recorded = payout?.output?.outstanding;
  if (recorded && typeof recorded === "object") {
    outstandingPayouts = {};
    for (const [currency, amount] of Object.entries(recorded as Record<string, unknown>)) {
      if (isDecimalAmount(amount)) outstandingPayouts[currency] = amount;
    }
  }

  return {
    jobId: row.id,
    status: row.status,
    completedSteps,
    remainingSteps,
    failedStep: steps.find((s) => s.status === "failed")?.name ?? null,
    outstandingPayouts,
    completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt,
  };
}

export async function loadRetirementReconciliation(
  talosId: string,
  executor: ReadExecutor = db,
): Promise<RetirementReconciliationSummary | null> {
  const row = await executor
    .select({
      id: tlsProvisioningJobs.id,
      status: tlsProvisioningJobs.status,
      steps: tlsProvisioningJobs.steps,
      completedAt: tlsProvisioningJobs.completedAt,
    })
    .from(tlsProvisioningJobs)
    .where(and(eq(tlsProvisioningJobs.talosId, talosId), eq(tlsProvisioningJobs.action, "retire")))
    .orderBy(desc(tlsProvisioningJobs.createdAt))
    .limit(1)
    .then((r) => r[0] ?? null);

  return row ? summarizeRetirementReconciliation(row) : null;
}
