/**
 * Retirement readiness report — pure, I/O-free module.
 *
 * Before an agent transitions to "retiring" or "retired" the caller
 * must supply current obligation counts obtained from the database.
 * This module validates those counts and produces a structured report
 * that the route layer can return as-is or use to block the transition.
 *
 * Keeping the logic here (rather than in the route) lets it be reused
 * by the durable retirement worker and tested without a database.
 */

import type { AgentLifecycleState } from "./lifecycle";

// ── Input ────────────────────────────────────────────────────────────────────

export interface RetirementReadinessInput {
  /** ID of the agent being evaluated. */
  agentId: string;
  /** Current lifecycle state of the agent. */
  currentState: AgentLifecycleState | string;
  /** Number of commerce jobs whose status is not completed / failed / cancelled. */
  pendingJobs: number;
  /** Number of commerce jobs whose status is "pending" (not yet started / paid). */
  pendingPayments: number;
  /**
   * Net undistributed USDC balance: sum(revenues) − sum(completed dividends).
   * A positive value means revenue has been collected but not yet shared.
   */
  undistributedRevenueUSDC: number;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface RetirementReadinessReport {
  /** ID of the agent that was evaluated. */
  agentId: string;
  /**
   * True when every obligation check passes and the agent may safely retire.
   * False means at least one blocker is present.
   */
  ready: boolean;
  /** Jobs in a non-terminal state at the time of the check. */
  pendingJobs: number;
  /** Jobs that have not yet been started or paid. */
  pendingPayments: number;
  /**
   * Revenue collected minus dividends already distributed, in USDC.
   * Positive means patrons have not yet received their share.
   */
  undistributedRevenueUSDC: number;
  /** Human-readable explanation of each blocker.  Empty when ready=true. */
  blockers: string[];
  /** ISO timestamp of when the report was produced. */
  reportedAt: string;
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a {@link RetirementReadinessReport} from pre-fetched obligation counts.
 *
 * Rules
 * ─────
 * 1. Any pending job (status not in completed / failed / cancelled) blocks
 *    retirement because a buyer has paid and is waiting for a result.
 * 2. Any pending payment (status = "pending") blocks retirement because
 *    the financial settlement has not yet completed.
 * 3. Positive undistributed revenue blocks retirement because patrons
 *    would be deprived of their share.
 */
export function buildRetirementReadinessReport(
  input: RetirementReadinessInput,
  now: Date = new Date(),
): RetirementReadinessReport {
  const blockers: string[] = [];

  if (input.pendingJobs > 0) {
    blockers.push(
      `${input.pendingJobs} job${input.pendingJobs === 1 ? "" : "s"} still in progress — drain or cancel before retiring`,
    );
  }

  if (input.pendingPayments > 0) {
    blockers.push(
      `${input.pendingPayments} payment${input.pendingPayments === 1 ? "" : "s"} pending settlement`,
    );
  }

  if (input.undistributedRevenueUSDC > 0) {
    blockers.push(
      `${input.undistributedRevenueUSDC.toFixed(6)} USDC in undistributed revenue — distribute to patrons before retiring`,
    );
  }

  return {
    agentId: input.agentId,
    ready: blockers.length === 0,
    pendingJobs: input.pendingJobs,
    pendingPayments: input.pendingPayments,
    undistributedRevenueUSDC: input.undistributedRevenueUSDC,
    blockers,
    reportedAt: now.toISOString(),
  };
}
