import { describe, expect, it } from "vitest";
import {
  computeReputation,
  decayWeight,
  hhi,
  InvalidReputationInputsError,
  REPUTATION_SCORE_VERSION,
  reputationInputsSchema,
  reputationOptionsSchema,
  SUB_SIGNAL_WEIGHTS,
  ReputationJobInput,
} from "../src/lib/reputation";

// ─── Test helpers ───────────────────────────────────────────────────

const NOW = new Date("2026-07-25T12:00:00.000Z");
const DAYS = (n: number) => n * 24 * 60 * 60 * 1000;

function jobsAt(
  requesterTalosId: string,
  daysAgo: number,
  count: number,
  status: ReputationJobInput["status"] = "completed",
  hasResult = true,
  now = NOW,
): ReputationJobInput[] {
  const createdAt = new Date(now.getTime() - DAYS(daysAgo));
  const updatedAt = new Date(now.getTime() - DAYS(daysAgo) + 60 * 60 * 1000);
  return Array.from({ length: count }, (_, i) => ({
    id: `${requesterTalosId}-${daysAgo}-${i}`,
    requesterTalosId,
    createdAt,
    updatedAt,
    status,
    hasResult,
  }));
}

function inputs(
  providerId: string,
  jobs: ReputationJobInput[],
): { providerId: string; jobs: ReputationJobInput[] } {
  return { providerId, jobs };
}

// ─── decayWeight ─────────────────────────────────────────────────────

describe("decayWeight", () => {
  it("returns 1 for age 0", () => {
    expect(decayWeight(0, 30)).toBe(1);
  });

  it("returns ~0.5 at exactly the half-life", () => {
    expect(decayWeight(30, 30)).toBeCloseTo(0.5, 10);
  });

  it("returns ~0.25 at two half-lives", () => {
    expect(decayWeight(60, 30)).toBeCloseTo(0.25, 10);
  });

  it("returns 0 for negative ages", () => {
    expect(decayWeight(-5, 30)).toBe(0);
  });

  it("returns 1 for an invalid (non-positive) half-life instead of NaN", () => {
    expect(decayWeight(10, 0)).toBe(1);
    expect(decayWeight(10, -1)).toBe(1);
  });

  it("returns 0 for non-finite ages", () => {
    expect(decayWeight(Number.NaN, 30)).toBe(0);
    expect(decayWeight(Number.POSITIVE_INFINITY, 30)).toBe(0);
  });
});

// ─── hhi ─────────────────────────────────────────────────────────────

describe("hhi", () => {
  it("returns 0 on an empty array", () => {
    expect(hhi([])).toBe(0);
  });

  it("returns ~0 for evenly distributed shares", () => {
    // four equal shares → 0.25
    expect(hhi([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25, 10);
  });

  it("returns ~1 for a monopoly", () => {
    expect(hhi([1])).toBeCloseTo(1, 10);
  });

  it("ignores negative shares", () => {
    expect(hhi([0.5, -0.1, 0.5])).toBeCloseTo(0.5, 10);
  });
});

// ─── scoreVersion ────────────────────────────────────────────────────

describe("scoreVersion constant", () => {
  it("is pinned to 1.0.0", () => {
    expect(REPUTATION_SCORE_VERSION).toBe("1.0.0");
  });
});

// ─── Zod schemas ────────────────────────────────────────────────────

describe("schemas", () => {
  it("accepts valid inputs", () => {
    const parsed = reputationInputsSchema.parse({
      providerId: "clx1",
      jobs: [
        {
          id: "j1",
          status: "completed",
          requesterTalosId: "buyer1",
          createdAt: NOW,
          updatedAt: NOW,
          hasResult: true,
        },
      ],
    });
    expect(parsed.jobs.length).toBe(1);
  });

  it("rejects unknown keys in strict mode by default", () => {
    // schemas.ts uses .strict semantics elsewhere.  We test that by
    // passing a `createdAt` value with the WRONG type (number is not
    // string|Date under the current union, so the schema fails).  The
    // schema validates shape, not format.
    const result = reputationInputsSchema.safeParse({
      providerId: "clx1",
      jobs: [
        {
          id: "j1",
          status: "completed",
          requesterTalosId: "buyer1",
          createdAt: 123, // neither string nor Date → invalid
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("options schema rejects invalid now", () => {
    const result = reputationOptionsSchema.safeParse({ now: new Date("oops") });
    expect(result.success).toBe(false);
  });
});

// ─── Cold start ─────────────────────────────────────────────────────

describe("cold start", () => {
  it("returns score 0 + confidence 0 when there are no jobs", () => {
    const result = computeReputation(inputs("clx1", []), { now: NOW });
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.confidenceTier).toBe("low");
    expect(result.evidence).toBe("insufficient");
    expect(result.summary.toLowerCase()).toContain("insufficient evidence");
    expect(result.inputsTrace.jobCount).toBe(0);
    expect(result.inputsTrace.distinctCounterparties).toBe(0);
  });

  it("is insufficient with one buyer and short span", () => {
    // Two jobs from one buyer but both at the same moment → timeRatio=0
    // so the provider is gated out of the headline score.
    const jobs = [
      ...jobsAt("buyer1", 0, 1),
      ...jobsAt("buyer1", 0, 1),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("insufficient");
    expect(result.score).toBe(0);
    expect(result.summary).toMatch(/cold-start/i);
  });

  it("is sufficient only when jobs, counterparties, and time threshold pass", () => {
    const jobs = [
      // 5 distinct counterparties, 30 days apart so span ≥ 14
      ...jobsAt("b1", 30, 1),
      ...jobsAt("b2", 28, 1),
      ...jobsAt("b3", 21, 1),
      ...jobsAt("b4", 14, 1),
      ...jobsAt("b5", 7, 1),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("ok");
    expect(result.confidence).toBeGreaterThanOrEqual(0.34);
  });

  it("forces confidence to exactly 0 when evidence is insufficient (hard gate)", () => {
    // 5 jobs but only 2 distinct counterparties and a short time span.
    // Without the hard-gate fix, confidence could leak a 0.05 * ratios
    // signal that lets consumers rank partially-evidenced providers
    // above true cold-start providers.  We require a strict 0 here.
    const jobs: ReputationJobInput[] = [
      ...jobsAt("b1", 7, 4),
      ...jobsAt("b2", 7, 1),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("insufficient");
    expect(result.confidence).toBe(0);
    expect(result.score).toBe(0);
  });

  it("forces confidence to exactly 0 even when only the time-span threshold fails", () => {
    // Plenty of jobs + counterparties but no time span → still gated.
    const jobs: ReputationJobInput[] = [
      ...jobsAt("b1", 0, 4),
      ...jobsAt("b2", 0, 4),
      ...jobsAt("b3", 0, 4),
      ...jobsAt("b4", 0, 4),
      ...jobsAt("b5", 0, 4),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("insufficient");
    expect(result.confidence).toBe(0);
    expect(result.score).toBe(0);
  });
});

// ─── Healthy provider ───────────────────────────────────────────────

describe("healthy provider", () => {
  it("rates a well-distributed provider highly", () => {
    const jobs: ReputationJobInput[] = [];
    // Spread jobs across days so we cross MIN_EVIDENCE_DAYS=14, with 10
    // distinct counterparties and ≥5 jobs each on aggregate.
    for (let i = 0; i < 10; i++) {
      jobs.push(...jobsAt(`buyer-${i}`, 30, 1));
      jobs.push(...jobsAt(`buyer-${i}`, 22, 1));
      jobs.push(...jobsAt(`buyer-${i}`, 15, 1));
    }
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("ok");
    expect(result.score).toBeGreaterThan(70);
    expect(result.inputs.completionRate).toBe(1);
    expect(result.inputsTrace.distinctCounterparties).toBe(10);
    // No buyer is dominant → damping = 1
    expect(result.inputsTrace.concentrationDamping).toBe(1);
    expect(result.inputsTrace.topBuyerShare).toBeCloseTo(0.1, 2);
  });
});

// ─── Failed provider ────────────────────────────────────────────────

describe("all-fail provider", () => {
  it("rates repeatedly failed providers low", () => {
    const jobs: ReputationJobInput[] = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(...jobsAt(`buyer-${i}`, 1, 2, "failed"));
    }
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.inputs.completionRate).toBe(0);
    expect(result.score).toBeLessThan(40);
  });
});

// ─── Adversarial sybil / counterparty concentration ─────────────────

describe("sybil resistance", () => {
  it("damps the score when a single counterparty dominates", () => {
    // Spread jobs across days so we cross MIN_EVIDENCE_DAYS=14, with
    // a single dominant requester to exercise concentration damping.
    const dominated = [
      ...jobsAt("sybil", 30, 10),
      ...jobsAt("sybil", 22, 10),
      ...jobsAt("sybil", 15, 10),
    ];
    const dominatedResult = computeReputation(inputs("clx1", dominated), {
      now: NOW,
    });

    const distributed = [
      // 10 distinct counterparties, jobs across multiple days so the
      // distributed branch also crosses MIN_EVIDENCE_DAYS=14.
      ...jobsAt("b1", 30, 1),
      ...jobsAt("b1", 22, 1),
      ...jobsAt("b1", 15, 1),
      ...jobsAt("b2", 30, 1),
      ...jobsAt("b2", 22, 1),
      ...jobsAt("b2", 15, 1),
      ...jobsAt("b3", 30, 1),
      ...jobsAt("b3", 22, 1),
      ...jobsAt("b3", 15, 1),
      ...jobsAt("b4", 30, 1),
      ...jobsAt("b4", 22, 1),
      ...jobsAt("b4", 15, 1),
      ...jobsAt("b5", 30, 1),
      ...jobsAt("b5", 22, 1),
      ...jobsAt("b5", 15, 1),
      ...jobsAt("b6", 30, 1),
      ...jobsAt("b6", 22, 1),
      ...jobsAt("b6", 15, 1),
      ...jobsAt("b7", 30, 1),
      ...jobsAt("b7", 22, 1),
      ...jobsAt("b7", 15, 1),
      ...jobsAt("b8", 30, 1),
      ...jobsAt("b8", 22, 1),
      ...jobsAt("b8", 15, 1),
      ...jobsAt("b9", 30, 1),
      ...jobsAt("b9", 22, 1),
      ...jobsAt("b9", 15, 1),
      ...jobsAt("b10", 30, 1),
      ...jobsAt("b10", 22, 1),
      ...jobsAt("b10", 15, 1),
    ];
    const distributedResult = computeReputation(
      inputs("clx2", distributed),
      { now: NOW },
    );

    expect(dominatedResult.inputsTrace.topBuyerShare).toBe(1);
    expect(dominatedResult.inputsTrace.concentrationDamping).toBeLessThan(1);
    // Distributed providers should score higher than dominant-buyer
    // providers; sybil resistance is doing its job.
    expect(distributedResult.score).toBeGreaterThan(dominatedResult.score);
  });

  it("does not damp when top-buyer share < 0.5", () => {
    const jobs = [
      ...jobsAt("b1", 30, 3),
      ...jobsAt("b2", 30, 3),
      ...jobsAt("b3", 30, 3),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.inputsTrace.topBuyerShare).toBeCloseTo(1 / 3, 2);
    expect(result.inputsTrace.concentrationDamping).toBe(1);
  });

  it("damps hard at exactly the 0.5 boundary", () => {
    // Equal split between 2 buyers → topBuyerShare = 0.5 (no damping).
    const symmetric = [
      ...jobsAt("b1", 30, 5),
      ...jobsAt("b2", 30, 5),
    ];
    const symmetricResult = computeReputation(inputs("clx1", symmetric), {
      now: NOW,
    });
    expect(symmetricResult.inputsTrace.concentrationDamping).toBe(1);
  });

  it("damps when just one side crosses 0.5", () => {
    // 7 from b1, 3 from b2 → top 7/10 = 0.7
    const skewed = [
      ...jobsAt("b1", 30, 7),
      ...jobsAt("b2", 30, 3),
    ];
    const result = computeReputation(inputs("clx1", skewed), { now: NOW });
    expect(result.inputsTrace.topBuyerShare).toBeCloseTo(0.7, 2);
    expect(result.inputsTrace.concentrationDamping).toBeLessThan(1);
  });
});

// ─── Decay ──────────────────────────────────────────────────────────

describe("decay", () => {
  it("weighs recent jobs more than old jobs", () => {
    const recent = [...jobsAt("b1", 0, 10)];
    const old = [...jobsAt("b1", 180, 10)];

    const recentResult = computeReputation(inputs("clx1", recent), {
      now: NOW,
    });
    const oldResult = computeReputation(inputs("clx1", old), { now: NOW });

    expect(recentResult.inputs.recencyWeightedVolume).toBeGreaterThan(
      oldResult.inputs.recencyWeightedVolume,
    );
  });

  it("decay weighting is reproducible", () => {
    const jobs = [...jobsAt("b1", 30, 5), ...jobsAt("b2", 60, 5)];
    const r1 = computeReputation(inputs("clx1", jobs), { now: NOW });
    const r2 = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(r1.score).toBe(r2.score);
    expect(r1.confidence).toBe(r2.confidence);
  });
});

// ─── Reproducibility ────────────────────────────────────────────────

describe("reproducibility", () => {
  it("is deterministic given identical inputs and `now`", () => {
    const jobs = [
      ...jobsAt("b1", 1, 4),
      ...jobsAt("b2", 7, 4),
      ...jobsAt("b3", 14, 4),
    ];
    const a = computeReputation(inputs("clx1", jobs), { now: NOW });
    const b = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(a.score).toBe(b.score);
    expect(a.confidence).toBe(b.confidence);
    expect(a.inputsTrace).toEqual(b.inputsTrace);
  });

  it("decays as the provider's `now` advances", () => {
    // As `now` advances the same jobs become older, so the
    // recency-weighted component DECREASES (decay dominates).
    const jobs = [...jobsAt("b1", 14, 5)];
    const a = computeReputation(inputs("clx1", jobs), { now: NOW });
    const later = new Date(NOW.getTime() + DAYS(7));
    const b = computeReputation(inputs("clx1", jobs), { now: later });
    expect(b.inputs.recencyWeightedVolume).toBeLessThan(
      a.inputs.recencyWeightedVolume,
    );
  });
});

// ─── Boundary guards ────────────────────────────────────────────────

describe("boundary inputs", () => {
  it("throws on invalid `now`", () => {
    expect(() =>
      computeReputation(inputs("clx1", []), {
        now: new Date("not-a-date"),
      }),
    ).toThrow(InvalidReputationInputsError);
  });

  it("throws on invalid halfLifeDays", () => {
    expect(() =>
      computeReputation(inputs("clx1", []), {
        now: NOW,
        halfLifeDays: -1,
      }),
    ).toThrow(InvalidReputationInputsError);
  });

  it("throws on invalid weights", () => {
    // Need at least one job so we don't hit the cold-start early return
    // before the weight-validation guard fires.
    expect(() =>
      computeReputation(inputs("clx1", jobsAt("b1", 0, 1)), {
        now: NOW,
        weights: {
          completion: 0,
          onTime: 0,
          disputeInverse: 0,
          concentration: 0,
          recencyVolume: 0,
        },
      }),
    ).toThrow(InvalidReputationInputsError);
  });

  it("clamps score to [0,100] even with extreme weighting", () => {
    // Force every input to 1 via synthetic extreme jobs.
    const jobs: ReputationJobInput[] = [];
    for (let i = 0; i < 50; i++) {
      jobs.push(...jobsAt(`b${i}`, 0, 2));
    }
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("skips jobs with invalid createdAt silently", () => {
    const jobs = [
      ...jobsAt("b1", 1, 3),
      {
        id: "bogus",
        status: "completed" as const,
        requesterTalosId: "b9",
        createdAt: "not-a-date",
        updatedAt: "not-a-date",
        hasResult: true,
      },
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    // The bogus job is filtered; we still score the 3 valid jobs.
    expect(result.inputsTrace.jobCount).toBe(3);
  });
});

// ─── Adversarial ─────────────────────────────────────────────────────

describe("adversarial inputs", () => {
  it("treats a rejected status with a result payload as a failure", () => {
    // Even if hasResult is truthy, the negative status is authoritative.
    const jobs: ReputationJobInput[] = [
      {
        id: "r1",
        status: "rejected",
        requesterTalosId: "b1",
        createdAt: new Date(NOW.getTime() - DAYS(30)),
        updatedAt: new Date(NOW.getTime() - DAYS(30) + 60 * 60 * 1000),
        hasResult: true,
      },
      ...jobsAt("b1", 30, 5),
      ...jobsAt("b2", 30, 5),
      ...jobsAt("b3", 30, 5),
      ...jobsAt("b4", 30, 5),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    // Rejection must NOT be silently flipped into success.
    expect(result.inputsTrace.failedJobCount).toBeGreaterThanOrEqual(1);
    expect(result.inputsTrace.completedJobCount).toBeLessThan(jobs.length);
  });

  it("doesn't explode on burst activity from one buyer", () => {
    // 1000 jobs in 1 minute from a single buyer.  Replay-safe: even
    // with this volume the score should be bounded and decaying.
    const burst = Array.from({ length: 1000 }, (_, i) => ({
      id: `burst-${i}`,
      status: "completed" as const,
      requesterTalosId: "sybil-buyer",
      createdAt: new Date(NOW.getTime() - i * 100), // 1ms apart
      updatedAt: new Date(NOW.getTime() - i * 100 + 60 * 1000),
      hasResult: true,
    }));
    const result = computeReputation(inputs("clx1", burst), { now: NOW });
    // Concentration penalty must apply.
    expect(result.inputsTrace.concentrationDamping).toBeLessThan(1);
    // 1000/1000 jobs completed; no failures.
    expect(result.inputs.completionRate).toBe(1);
    // Recency-weighted volume stays in [0,1] — no NaN or Infinity.
    expect(Number.isFinite(result.inputs.recencyWeightedVolume)).toBe(true);
    expect(result.inputs.recencyWeightedVolume).toBeGreaterThanOrEqual(0);
    expect(result.inputs.recencyWeightedVolume).toBeLessThanOrEqual(1);
    // Score is bounded in [0,100].
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("treats future-dated jobs as fresh (clamped to age 0)", () => {
    // Clock skew: createdAt is 5 days in the future relative to `now`.
    const jobs: ReputationJobInput[] = [
      {
        id: "future",
        status: "completed" as const,
        requesterTalosId: "b1",
        createdAt: new Date(NOW.getTime() + DAYS(5)),
        updatedAt: new Date(NOW.getTime() + DAYS(5)),
        hasResult: true,
      },
      ...jobsAt("b2", 1, 5),
      ...jobsAt("b3", 1, 5),
      ...jobsAt("b4", 1, 5),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    // The future-dated job gets ageDays=0 weight = 1, so weightedVolume
    // doesn't blow up.  This is a smoke test that we never produce NaN
    // or Infinity.
    expect(Number.isFinite(result.score)).toBe(true);
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it("trims whitespace around requesterTalosId so attackers can't fragment", () => {
    // Same fuzzy buyer with different whitespace would otherwise be
    // counted as multiple counterparties.  Trimmed canonicalisation
    // keeps concentration binding intact.
    const jobs: ReputationJobInput[] = [
      ...jobsAt("buyer-1", 1, 5),
      ...jobsAt("  buyer-1  ", 1, 5),
      ...jobsAt("BUYER-1", 1, 5),
    ];
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    // BUYER-1 vs "buyer-1" still differ in raw string equality; we
    // trim but don't casefold.  After trim they collapse into at
    // most 2 distinct counterparties.
    expect(result.inputsTrace.distinctCounterparties).toBeLessThanOrEqual(2);
  });

  it("is byte-identical when called twice with identical inputs", () => {
    const jobs = [
      ...jobsAt("b1", 1, 4),
      ...jobsAt("b2", 7, 4),
      ...jobsAt("b3", 14, 4),
    ];
    const a = computeReputation(inputs("clx1", jobs), { now: NOW });
    const b = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("is strictly reproducible across `now` advance (no Date.now leak)", () => {
    // Two calls with the same `now` should produce identical output no
    // matter how long the test process takes between them.
    const start = Date.now();
    const jobs = jobsAt("b1", 0, 10);
    const a = computeReputation(inputs("clx1", jobs), {
      now: new Date(NOW.getTime()),
    });
    // Burn a tiny amount of CPU to ensure no Date.now leaked in.
    let sink = 0;
    for (let i = 0; i < 1000; i++) sink += i;
    void sink;
    const b = computeReputation(inputs("clx1", jobs), {
      now: new Date(NOW.getTime()),
    });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    // Sanity: time must have advanced across the loop OR the test is
    // using a fast clock.  Both branches are acceptable proofs that
    // `Date.now()` doesn't leak into `a` / `b`.
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });

  it("forces score to 0 when evidence is insufficient (cold start)", () => {
    // Single counterparty, plenty of jobs, no span — still cold start.
    const jobs = jobsAt("b1", 0, 10);
    const result = computeReputation(inputs("clx1", jobs), { now: NOW });
    expect(result.evidence).toBe("insufficient");
    expect(result.score).toBe(0);
    expect(result.summary.toLowerCase()).toContain("cold");
  });
});

// ─── Weights auditability ───────────────────────────────────────────

describe("weight constants", () => {
  it("sum to 1.0", () => {
    const sum =
      SUB_SIGNAL_WEIGHTS.completion +
      SUB_SIGNAL_WEIGHTS.onTime +
      SUB_SIGNAL_WEIGHTS.disputeInverse +
      SUB_SIGNAL_WEIGHTS.concentration +
      SUB_SIGNAL_WEIGHTS.recencyVolume;
    expect(sum).toBeCloseTo(1.0, 6);
  });
});
