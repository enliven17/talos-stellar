import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsCommerceJobs, tlsTalos } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  computeReputation,
  REPUTATION_SCORE_VERSION,
  reputationInputsSchema,
  ReputationJobInput,
} from "@/lib/reputation";

export const dynamic = "force-dynamic";

/**
 * Maximum drift between server time and caller-supplied `?now=`.
 * Larger drifts are rejected (HTTP 400) to prevent reputation
 * laundering: a malicious caller can't pin `now=2099-01-01` to keep a
 * stale cohort of jobs fresh.
 */
const NOW_DRIFT_LIMIT_SECONDS = 24 * 60 * 60;

const querySchema = z.object({
  /**
   * Optional ISO timestamp the caller wants the score evaluated at.
   * Useful for deterministic replays (cache keys, audits). If absent,
   * the route falls back to `Date.now()` server-side.  Must be within
   * ±24h of server time.
   */
  now: z
    .string()
    .datetime({ offset: true })
    .optional(),
  /**
   * Optional cap on how many recent jobs to load.
   * Defaults to 5_000 which is enough for cold-start + healthy-provider
   * scenarios and bounded to avoid runaway queries.
   */
  jobLimit: z.coerce.number().int().positive().max(10_000).optional(),
});

/**
 * Maximum age of a job (days) that will be considered for scoring.
 * Prevents ancient activity from skewing the score and bounds query
 * cost at the DB layer (one indexed scan filtered by `createdAt`).
 */
const MAX_JOB_AGE_DAYS = 365;

/**
 * GET /api/talos/:id/reputation
 *
 * Returns a versioned reputation score for a provider TALOS with:
 *  - explicit input sub-signals (auditable / reproducible)
 *  - confidence in [0,1] tied to evidence quality
 *  - bounded sybil influence via counterparty-concentration damping
 *  - decay (older jobs weight less)
 *
 * Public read — same posture as `/api/talos/:id/credit-score`.  A future
 * roadmap item may tighten this to Patron-only readers; until then, the
 * endpoint exposes no PII (only TALOS ids, counts, and shares).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const parseResult = querySchema.safeParse(parseQuery(request));
    if (!parseResult.success) {
      return Response.json(
        {
          error: "Invalid query parameters",
          issues: parseResult.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
          ),
        },
        { status: 400 },
      );
    }

    const { now, jobLimit } = parseResult.data;
    const evaluatedAt = now ? new Date(now) : new Date();
    if (!Number.isFinite(evaluatedAt.getTime())) {
      return Response.json(
        { error: "`now` must be a valid ISO datetime" },
        { status: 400 },
      );
    }

    // Reputation-laundering guard.  Reject any caller-supplied `now`
    // that drifts more than 24h from the server's clock so a malicious
    // client cannot pin its evaluation to "fresh-for-100-years".
    if (now) {
      const driftMs = Math.abs(evaluatedAt.getTime() - Date.now());
      if (driftMs > NOW_DRIFT_LIMIT_SECONDS * 1000) {
        return Response.json(
          {
            error:
              "`now` must be within 24h of server time to prevent " +
              "reputation laundering",
          },
          { status: 400 },
        );
      }
    }

    // Provider existence check — 404 lets mirrors detect "agent gone" rather
    // than mistaking an empty score for a missing provider.
    const provider = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!provider) {
      return Response.json(
        { error: "TALOS not found" },
        { status: 404 },
      );
    }

    // Pull the provider's recent commerce jobs, bounded by recency and
    // a hard cap on the requested `jobLimit`.
    const cutoff = new Date(
      evaluatedAt.getTime() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000,
    );
    const limit = jobLimit ?? 5_000;

    const jobRows = await db
      .select({
        id: tlsCommerceJobs.id,
        status: tlsCommerceJobs.status,
        requesterTalosId: tlsCommerceJobs.requesterTalosId,
        createdAt: tlsCommerceJobs.createdAt,
        updatedAt: tlsCommerceJobs.updatedAt,
        result: tlsCommerceJobs.result,
      })
      .from(tlsCommerceJobs)
      .where(
        and(
          eq(tlsCommerceJobs.talosId, id),
          sql`${tlsCommerceJobs.createdAt} >= ${cutoff}`,
        ),
      )
      .orderBy(desc(tlsCommerceJobs.createdAt))
      .limit(limit);

    // Map DB rows → reputation input.  `hasResult` is true when the seller
    // submitted a non-null structured result payload (a stronger signal
    // than `status=completed` alone because empty results can exist as
    // placeholders during async chutes).
    const jobs: ReputationJobInput[] = jobRows.map((row) => ({
      id: row.id,
      status: row.status ?? "unknown",
      requesterTalosId: row.requesterTalosId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasResult: row.result != null && Object.keys(row.result as object).length > 0,
    }));

    // Validate before passing to the pure scoring module.  This guards
    // against future DB schema drift silently breaking the math.
    const inputs = reputationInputsSchema.parse({
      providerId: provider.id,
      jobs,
    });

    const score = computeReputation(inputs, { now: evaluatedAt });

    // Single source of truth for `scoreVersion`: the lib exports the
    // constant and `computeReputation` echoes it back on the result.
    // We deliberately don't pin a second literal in this file, so an
    // unintended bump in either place fails fast at typecheck / test
    // time instead of silently drifting.
    //
    // When the caller pinned `now`, mark the response as no-store so
    // edge caches don't pin a custom-`now` result globally.
    const cacheControl = now
      ? "no-store"
      : "public, max-age=60, stale-while-revalidate=300";

    return Response.json(
      {
        ...score,
        // Top-level `scoreVersion` is already in `score`; we omit the
        // duplicate rather than silently overriding it.
        requestedNow: now ?? null,
        requestedJobLimit: limit,
        windowDays: MAX_JOB_AGE_DAYS,
      },
      {
        headers: {
          "Cache-Control": cacheControl,
          "X-Reputation-Version": REPUTATION_SCORE_VERSION,
        },
      },
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json(
        {
          error: "Invalid reputation inputs",
          issues: err.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
          ),
        },
        { status: 400 },
      );
    }
    console.error("[reputation GET]", err);
    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

function parseQuery(request: NextRequest): Record<string, string> {
  const { searchParams } = new URL(request.url);
  const out: Record<string, string> = {};
  for (const [k, v] of searchParams.entries()) {
    out[k] = v;
  }
  return out;
}
