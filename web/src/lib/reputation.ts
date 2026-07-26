/**
 * Provider Reputation Scoring
 * ────────────────────────────
 *
 * Pure, deterministic scoring function that turns a provider's (TALOS agent)
 * observable commerce-job history into a 0–100 reputation score with a
 * confidence value and a publisher-visible exposure of every input class.
 *
 * Design goals (issue #306)
 *  - scoreVersion is a string constant so the formula can evolve without
 *    silently mixing semantics for consumers / cached scores
 *  - Input classes are emitted on the output so reviewers can see what
 *    contributed to the score (auditability / reproducibility)
 *  - Cold start is treated as **insufficient evidence**, not as 0
 *  - Decay: events older than some half-life contribute less
 *  - Counterparty concentration is bounded (sybil / self-trade damping)
 *  - The function is **pure** — every input, including `now`, is passed in,
 *    so the same dataset always produces the same score (replay-resistant)
 *
 * The companion API route (/api/talos/:id/reputation) fetches jobs, calls
 * `computeReputation`, and returns the result verbatim.  All numeric
 * derivation lives in this file so tests can cover it without HTTP or DB.
 */

import { z } from "zod/v4";

// ─── Public, consumer-facing version constant ────────────────────────
// Bump on any semantic change.  Consumers can pin to a specific version
// and treat a different version as a definitional break.
export const REPUTATION_SCORE_VERSION = "1.0.0" as const;

/** Half-life for the exponential decay weighting of past jobs (days). */
export const REPUTATION_HALF_LIFE_DAYS = 30;

/** Latency budget considered "on-time" for fulfillment latency signal. */
export const ON_TIME_BUDGET_HOURS = 24;

/**
 * Upper bound for how much any single counterparty can contribute to the
 * concentration weighting.  A buyer with ≥ `MAX_SINGLE_BUYER_SHARE`
 * triggers bounded damping rather than hard exclusion.
 */
export const MAX_SINGLE_BUYER_SHARE = 0.5;

/**
 * HHI value at which `concentrationInverse` is considered neutral (1.0).
 * Below this level we do not penalise concentration at all.  Above it we
 * fall off linearly so that a pure monopoly (HHI = 1) yields inverse = 0.
 */
export const CONCENTRATION_NEUTRAL_HHI = 0.25;

/** Minimum evidence thresholds — failing any keeps confidence very low. */
export const MIN_EVIDENCE_JOBS = 5;
export const MIN_EVIDENCE_COUNTERPARTIES = 3;
export const MIN_EVIDENCE_DAYS = 14;

/**
 * Confidence-tier boundaries.  Confidence ∈ [0,1] maps to:
 *   < LOW_BOUND           → low
 *   [LOW_BOUND, HIGH_BOUND) → medium
 *   ≥ HIGH_BOUND          → high
 */
export const CONFIDENCE_LOW_BOUND = 0.34;
export const CONFIDENCE_HIGH_BOUND = 0.67;

/**
 * Default sub-signal weights.  Must sum to 1.0.  Annotated as
 * `ReputationWeights` (not `as const`) so adding/removing a key
 * surfaces at typecheck instead of silently breaking callers /
 * cast-sites.
 */
export const SUB_SIGNAL_WEIGHTS: ReputationWeights = {
  completion: 0.35,
  onTime: 0.15,
  disputeInverse: 0.1,
  concentration: 0.15,
  recencyVolume: 0.25,
};

/**
 * Wider shape used at function boundaries.  Any caller-supplied
 * override for `ReputationOptions.weights` must conform to this shape.
 */
export type ReputationWeights = {
  completion: number;
  onTime: number;
  disputeInverse: number;
  concentration: number;
  recencyVolume: number;
};

/** Statuses that count as "successful fulfillment". */
const POSITIVE_STATUSES: Set<string> = new Set([
  "completed",
  "accepted",
  "fulfilled",
  "settled",
]);

/** Statuses that count as "failure / dispute". */
const NEGATIVE_STATUSES: Set<string> = new Set([
  "failed",
  "rejected",
  "cancelled",
  "disputed",
]);

// ─── Types ───────────────────────────────────────────────────────────

export type ReputationJobStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "counter_offer"
  | "rejected"
  | "completed"
  | "fulfilled"
  | "settled"
  | "failed"
  | "cancelled"
  | "disputed"
  | "unknown";

export interface ReputationJobInput {
  id: string;
  /** Status as recorded in tls_commerce_jobs. */
  status: ReputationJobStatus | string;
  /** Buyer's TALOS id (or "human:<pubkey>" namespace for human requesters). */
  requesterTalosId: string;
  /** When the job was created. */
  createdAt: Date | string;
  /**
   * When the job last transitioned (e.g. fulfilled, rejected).
   * If absent, treated as equal to createdAt (no latency signal).
   */
  updatedAt?: Date | string | null;
  /**
   * Whether the seller submitted a structured result payload.
   * Submitted results are stronger positive signals than `status=completed`
   * alone.
   */
  hasResult?: boolean;
}

export interface ReputationInputs {
  /** The provider's TALOS id (purely informational, not used in math). */
  providerId: string;
  /** Job history used to derive the score. */
  jobs: ReputationJobInput[];
}

export interface ReputationOptions {
  /**
   * "Now" anchor for recency / decay calculations.  Defaults to the supplied
   * `now` of the caller; never reads `Date.now()` so the function stays pure.
   */
  now: Date;
  /** Override dev knobs — kept stable for tests and future tuning. */
  halfLifeDays?: number;
  onTimeBudgetHours?: number;
  maxSingleBuyerShare?: number;
  /**
   * Optional per-sub-signal weight overrides.  Any subset of
   * `ReputationWeights` may be supplied; unspecified keys fall back to
   * the corresponding default in `SUB_SIGNAL_WEIGHTS` via spread-merging
   * inside `computeReputation`.  Sum of the merged weights is validated
   * to be > 0 before any math runs.
   */
  weights?: Partial<ReputationWeights>;
}

export interface ReputationScore {
  providerId: string;
  scoreVersion: typeof REPUTATION_SCORE_VERSION;
  /** 0–100; the headlined number for the provider. */
  score: number;
  /** 0–1; gamma-style confidence gate, 0 means "insufficient evidence". */
  confidence: number;
  /**
   * Discrete bucket of `confidence` for UI affordances.
   *   <0.34 low | 0.34–<0.67 medium | ≥0.67 high
   */
  confidenceTier: "low" | "medium" | "high";
  /** "insufficient" when cold-start evidence is below thresholds. */
  evidence: "insufficient" | "ok";

  /** Sub-signals that contributed to the score, each in [0,1]. */
  inputs: {
    completionRate: number;
    onTimeRate: number;
    disputeRateInverse: number;
    concentrationInverse: number;
    recencyWeightedVolume: number;
  };

  /** Evidence filed in the response for auditability / replay. */
  inputsTrace: {
    jobCount: number;
    completedJobCount: number;
    failedJobCount: number;
    onTimeJobCount: number;
    disputedJobCount: number;
    distinctCounterparties: number;
    timeSpanDays: number;
    halfLifeDays: number;
    onTimeBudgetHours: number;
    maxSingleBuyerShare: number;
    topBuyerShare: number;
    weights: ReputationWeights;
    /** Effective multiplier applied for concentration over the threshold. */
    concentrationDamping: number;
  };
  /** Provider-facing human-readable explanation for the score. */
  summary: string;
  generatedAt: string;
}

// ─── Zod schema for input validation at the route boundary ───────────

export const reputationJobInputSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  requesterTalosId: z.string().min(1),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z
    .union([z.string(), z.date()])
    .nullable()
    .optional(),
  hasResult: z.boolean().optional(),
});

export const reputationInputsSchema = z.object({
  providerId: z.string().min(1),
  jobs: z.array(reputationJobInputSchema).max(50_000),
});

export const reputationOptionsSchema = z.object({
  now: z.date(),
  halfLifeDays: z.number().positive().optional(),
  onTimeBudgetHours: z.number().positive().optional(),
  maxSingleBuyerShare: z.number().positive().max(1).optional(),
  weights: z
    .object({
      completion: z.number().nonnegative(),
      onTime: z.number().nonnegative(),
      disputeInverse: z.number().nonnegative(),
      concentration: z.number().nonnegative(),
      recencyVolume: z.number().nonnegative(),
    })
    .optional(),
});

// ─── Errors ──────────────────────────────────────────────────────────

export class InvalidReputationInputsError extends Error {
  constructor(reason: string) {
    super(`Invalid reputation inputs: ${reason}`);
    this.name = "InvalidReputationInputsError";
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function msPerDay(): number {
  return 24 * 60 * 60 * 1000;
}

/**
 * Exponential decay weight: `0.5^(ageDays / halfLifeDays)`.  Pure function
 * of age so it can be replayed deterministically.
 */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Herfindahl–Hirschman Index of a non-empty array of share values in [0,1]
 * that sum to ≤1.  Returns a value in [0,1] where 0 = perfectly distributed
 * and 1 = monopoly by one party.
 */
export function hhi(shares: number[]): number {
  let sum = 0;
  let total = 0;
  for (const s of shares) {
    if (!Number.isFinite(s) || s < 0) continue;
    total += s;
    sum += s * s;
  }
  if (total === 0) return 0;
  return Math.min(1, sum);
}

function confidenceTierOf(c: number): "low" | "medium" | "high" {
  if (c >= CONFIDENCE_HIGH_BOUND) return "high";
  if (c >= CONFIDENCE_LOW_BOUND) return "medium";
  return "low";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Compute a provider reputation score with confidence, decay, and bounded
 * counterparty concentration.
 *
 * Throws `InvalidReputationInputsError` if the inputs cannot be processed
 * (e.g. malformed `now`, negative job counts after sanitization).
 */
export function computeReputation(
  inputs: ReputationInputs,
  options: ReputationOptions,
): ReputationScore {
  // ── Validate + normalize options ────────────────────────────────────
  const halfLifeDays = options.halfLifeDays ?? REPUTATION_HALF_LIFE_DAYS;
  const onTimeBudgetHours =
    options.onTimeBudgetHours ?? ON_TIME_BUDGET_HOURS;
  const maxSingleBuyerShare =
    options.maxSingleBuyerShare ?? MAX_SINGLE_BUYER_SHARE;
  // Spread defaults so callers can pass any subset of weights via
  // `options.weights`; the final shape matches `ReputationWeights`.
  const weights: ReputationWeights = {
    ...SUB_SIGNAL_WEIGHTS,
    ...options.weights,
  };
  const now = toDate(options.now);
  if (!now) {
    throw new InvalidReputationInputsError("`now` must be a valid Date");
  }
  if (
    !Number.isFinite(halfLifeDays) ||
    halfLifeDays <= 0 ||
    !Number.isFinite(onTimeBudgetHours) ||
    onTimeBudgetHours <= 0 ||
    !Number.isFinite(maxSingleBuyerShare) ||
    maxSingleBuyerShare <= 0 ||
    maxSingleBuyerShare > 1
  ) {
    throw new InvalidReputationInputsError(
      "halfLifeDays / onTimeBudgetHours / maxSingleBuyerShare are out of range",
    );
  }

  // ── Normalize job list ──────────────────────────────────────────────
  const providerId = inputs.providerId;
  if (!providerId) {
    throw new InvalidReputationInputsError("providerId is required");
  }
  const rawJobs = Array.isArray(inputs.jobs) ? inputs.jobs : [];

  const jobs: Array<{
    id: string;
    requesterTalosId: string;
    createdAt: Date;
    updatedAt: Date | null;
    status: string;
    hasResult: boolean;
  }> = [];
  for (const job of rawJobs) {
    if (!job || typeof job !== "object") continue;
    const createdAt = toDate(job.createdAt);
    if (!createdAt) continue;
    const updatedAt =
      job.updatedAt == null
        ? null
        : toDate(job.updatedAt) ?? createdAt;
    jobs.push({
      id: String(job.id ?? ""),
      requesterTalosId: String(job.requesterTalosId ?? ""),
      createdAt,
      updatedAt,
      status: String(job.status ?? "").toLowerCase(),
      hasResult: Boolean(job.hasResult),
    });
  }

  // ── Cold start: insufficient evidence ───────────────────────────────
  const jobCount = jobs.length;
  if (jobCount === 0) {
    return coldStartScore(providerId, now, {
      weights,
      halfLifeDays,
      onTimeBudgetHours,
      maxSingleBuyerShare,
    });
  }

  // ── Aggregate counters ─────────────────────────────────────────────
  let completedCount = 0;
  let onTimeEligibleCount = 0;
  let onTimeCount = 0;
  let failedCount = 0;
  let disputedCount = 0;
  let weightedVolume = 0;
  let firstCreatedAt = jobs[0]!.createdAt;
  let maxCreatedAt = jobs[0]!.createdAt;
  const counterpartyShares = new Map<string, number>();

  // onTimeMsBudget derived once so the loop is allocation-light.
  const onTimeMsBudget = onTimeBudgetHours * 60 * 60 * 1000;

  for (const job of jobs) {
    if (job.createdAt.getTime() < firstCreatedAt.getTime()) {
      firstCreatedAt = job.createdAt;
    }
    if (job.createdAt.getTime() > maxCreatedAt.getTime()) {
      maxCreatedAt = job.createdAt;
    }
    // Future-dated jobs (clock skew) get clamped to age 0 so they
    // contribute with fresh weight; this prevents negative ages and
    // `Math.pow(0.5, -n)` from exploding the weightedVolume.
    const ageDays = Math.max(
      0,
      (now.getTime() - job.createdAt.getTime()) / msPerDay(),
    );
    const w = decayWeight(ageDays, halfLifeDays);
    weightedVolume += w;

    // Trim counterparty ids so trailing whitespace / case doesn't
    // accidentally fragment a single buyer's contribution.
    const cp = (job.requesterTalosId || "unknown").trim();
    counterpartyShares.set(cp, (counterpartyShares.get(cp) ?? 0) + w);

    // Negative-authoritative: a status of "failed" / "rejected" / etc.
    // must always reduce the positive tally, even if a result payload
    // is still attached (e.g. partial-failure records).  A job counts
    // as positive only when it is not negative-status *and* either has
    // a positive status or a non-empty result.
    const status = job.status as ReputationJobStatus;
    const isNegative = NEGATIVE_STATUSES.has(status);
    const isPositive =
      !isNegative &&
      (POSITIVE_STATUSES.has(status) || job.hasResult);
    if (isPositive) {
      completedCount += 1;
    } else if (isNegative) {
      failedCount += 1;
      if (status === "rejected" || status === "disputed") {
        disputedCount += 1;
      }
    }

    // On-time tracking: numerator and denominator use the same
    // positive-status set so they stay consistent.
    if (!isNegative && POSITIVE_STATUSES.has(status)) {
      onTimeEligibleCount += 1;
      if (
        job.updatedAt &&
        job.updatedAt.getTime() - job.createdAt.getTime() <= onTimeMsBudget
      ) {
        onTimeCount += 1;
      }
    }
  }

  // ── Sub-signals (each clamped to [0,1]) ─────────────────────────────
  const decided = completedCount + failedCount;
  const completionRate = decided > 0 ? completedCount / decided : 0;
  // Dispute rate: share of disputed outcomes among the "final"
  // decisions.  We intentionally use completed-count + disputed-count
  // as the denominator so a provider with many failures and few
  // disputes (typical of bot-net spam) isn't wrongly rewarded.  Guard
  // against zero with `Math.max(1, …)`.
  const disputes = disputedCount;
  const disputeRate =
    disputes > 0 && completedCount + disputedCount > 0
      ? disputes / Math.max(1, completedCount + disputedCount)
      : 0;
  const disputeRateInverse = clamp01(1 - clamp01(disputeRate));

  const onTimeRate =
    onTimeEligibleCount > 0 ? onTimeCount / onTimeEligibleCount : 0;

  // ── Counterparty HHI on weighted share ──────────────────────────────
  let totalWeightedShares = 0;
  for (const v of counterpartyShares.values()) totalWeightedShares += v;
  const shares: number[] = [];
  let topShare = 0;
  for (const v of counterpartyShares.values()) {
    const s = totalWeightedShares > 0 ? v / totalWeightedShares : 0;
    shares.push(s);
    if (s > topShare) topShare = s;
  }
  const concentrationIndex = hhi(shares);
  // Concentration inverse: full credit at HHI ≤ neutral, fall off
  // linearly to 0 at HHI = 1.  Using a named constant keeps the math
  // auditable.
  const concentrationFalloffDenominator =
    1 - CONCENTRATION_NEUTRAL_HHI;
  const concentrationInverse = clamp01(
    1 -
      Math.max(0, concentrationIndex - CONCENTRATION_NEUTRAL_HHI) /
        concentrationFalloffDenominator,
  );

  // Bounded sybil damping: hard-cap any single buyer at maxSingleBuyerShare.
  // If topShare exceeds that, apply a multiplicative reduction down to a
  // minimum 0.25 floor so a monopoly still yields a non-zero residue.
  const concentrationDamping =
    topShare <= maxSingleBuyerShare
      ? 1
      : Math.max(0.25, maxSingleBuyerShare / topShare);

  // ── Recency-weighted volume, log-scaled ────────────────────────────
  // Map weightedVolume to [0,1] via log10.  Tuned so that 10 fresh jobs
  // approximate a 0.5 contribution and 1000 fresh jobs ≈ 1.0.
  const recencyWeightedVolume = clamp01(
    Math.log10(1 + weightedVolume) / 3,
  );

  // ── Evidence (cold-start gate) ──────────────────────────────────────
  const distinctCounterparties = counterpartyShares.size;
  const timeSpanDays = Math.max(
    0,
    (maxCreatedAt.getTime() - firstCreatedAt.getTime()) / msPerDay(),
  );

  const jobRatio = clamp01(jobCount / MIN_EVIDENCE_JOBS);
  const counterpartyRatio = clamp01(
    distinctCounterparties / MIN_EVIDENCE_COUNTERPARTIES,
  );
  const timeRatio = clamp01(timeSpanDays / MIN_EVIDENCE_DAYS);
  const evidence: "insufficient" | "ok" =
    jobRatio >= 1 && counterpartyRatio >= 1 && timeRatio >= 1
      ? "ok"
      : "insufficient";
  // Hard-gate: confidence is exactly 0 whenever evidence is insufficient
  // (do not leak a 0.05 * ratios signal — that lets consumers rank partially-
  // evidenced providers above true cold-start providers, contradicting the
  // "Hard gate" contract in REPUTATION.md).  The empty-job coldStartScore
  // path also returns 0; both branches are now consistent.
  const confidence =
    evidence === "ok"
      ? Math.min(jobRatio, counterpartyRatio, timeRatio)
      : 0;

  // ── Composite base score ────────────────────────────────────────────
  const sumWeights =
    weights.completion +
    weights.onTime +
    weights.disputeInverse +
    weights.concentration +
    weights.recencyVolume;
  if (sumWeights <= 0) {
    throw new InvalidReputationInputsError("weights must be positive");
  }

  const weightedSum =
    weights.completion * completionRate +
    weights.onTime * onTimeRate +
    weights.disputeInverse * disputeRateInverse +
    weights.concentration * concentrationInverse +
    weights.recencyVolume * recencyWeightedVolume;

  const baseScoreFraction = weightedSum / sumWeights; // 0..1
  // Concentration damping: bound the headlined score when one buyer
  // dominates.  This is *the* sybil-resistance lever.
  const dampedFraction = baseScoreFraction * concentrationDamping;
  // Confidence adjusts the score so cold-start providers can't claim 90.
  const rawScore = dampedFraction * (0.4 + 0.6 * confidence) * 100;
  // Cold-start gate is authoritative: even with perfect sub-signals, a
  // provider without sufficient evidence receives score 0.  Consumers
  // can still inspect each `inputs.*` value, but the headlined number
  // stays at 0 until thresholds are met.
  const score =
    evidence === "insufficient"
      ? 0
      : Math.max(0, Math.min(100, rawScore));

  return {
    providerId,
    scoreVersion: REPUTATION_SCORE_VERSION,
    score: round2(score),
    confidence: round4(confidence),
    confidenceTier: confidenceTierOf(confidence),
    evidence,
    inputs: {
      completionRate: round4(completionRate),
      onTimeRate: round4(onTimeRate),
      disputeRateInverse: round4(disputeRateInverse),
      concentrationInverse: round4(concentrationInverse),
      recencyWeightedVolume: round4(recencyWeightedVolume),
    },
    inputsTrace: {
      jobCount,
      completedJobCount: completedCount,
      failedJobCount: failedCount,
      onTimeJobCount: onTimeCount,
      disputedJobCount: disputes,
      distinctCounterparties,
      timeSpanDays: round2(timeSpanDays),
      halfLifeDays,
      onTimeBudgetHours,
      maxSingleBuyerShare,
      topBuyerShare: round4(topShare),
      weights,
      concentrationDamping: round4(concentrationDamping),
    },
    summary: buildSummary({
      score,
      confidence,
      evidence,
      jobCount,
      distinctCounterparties,
      timeSpanDays,
      topShare,
      maxSingleBuyerShare,
      concentrationDamping,
    }),
    generatedAt: now.toISOString(),
  };
}

// ─── Helpers used only by `computeReputation` ────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function coldStartScore(
  providerId: string,
  now: Date,
  ctx: {
    weights: ReputationWeights;
    halfLifeDays: number;
    onTimeBudgetHours: number;
    maxSingleBuyerShare: number;
  },
): ReputationScore {
  return {
    providerId,
    scoreVersion: REPUTATION_SCORE_VERSION,
    score: 0,
    confidence: 0,
    confidenceTier: "low",
    evidence: "insufficient",
    inputs: {
      completionRate: 0,
      onTimeRate: 0,
      disputeRateInverse: 0,
      concentrationInverse: 0,
      recencyWeightedVolume: 0,
    },
    inputsTrace: {
      jobCount: 0,
      completedJobCount: 0,
      failedJobCount: 0,
      onTimeJobCount: 0,
      disputedJobCount: 0,
      distinctCounterparties: 0,
      timeSpanDays: 0,
      halfLifeDays: ctx.halfLifeDays,
      onTimeBudgetHours: ctx.onTimeBudgetHours,
      maxSingleBuyerShare: ctx.maxSingleBuyerShare,
      topBuyerShare: 0,
      weights: ctx.weights,
      concentrationDamping: 1,
    },
    summary:
      "Insufficient evidence. Need more jobs, distinct counterparties, " +
      "and elapsed time before a meaningful reputation score is published.",
    generatedAt: now.toISOString(),
  };
}

interface SummaryContext {
  score: number;
  confidence: number;
  evidence: "insufficient" | "ok";
  jobCount: number;
  distinctCounterparties: number;
  timeSpanDays: number;
  topShare: number;
  maxSingleBuyerShare: number;
  concentrationDamping: number;
}

function buildSummary(ctx: SummaryContext): string {
  if (ctx.evidence === "insufficient") {
    return `Cold-start regime: ${ctx.jobCount} jobs, ${ctx.distinctCounterparties} counterparties ` +
      `over ${ctx.timeSpanDays.toFixed(1)} days — confidence gated until ` +
      `${MIN_EVIDENCE_JOBS}+ jobs, ${MIN_EVIDENCE_COUNTERPARTIES}+ counterparties, ` +
      `≥${MIN_EVIDENCE_DAYS} days of activity accumulate.`;
  }
  const concentrationNote =
    ctx.topShare > ctx.maxSingleBuyerShare
      ? ` Counterparty concentration above ${(ctx.maxSingleBuyerShare * 100).toFixed(0)}% ` +
        `(${ctx.concentrationDamping.toFixed(2)}× damping) bounds the score.`
      : "";
  return `Score ${ctx.score.toFixed(2)}/100 @ confidence ${(ctx.confidence * 100).toFixed(1)}% ` +
    `(${ctx.jobCount} jobs, ${ctx.distinctCounterparties} counterparties, ` +
    `${ctx.timeSpanDays.toFixed(1)} days).${concentrationNote}`;
}
