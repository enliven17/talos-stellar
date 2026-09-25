/**
 * GET /api/health/ready - Readiness probe
 *
 * Answers: "Is the service ready to accept traffic?"
 * Runs all dependency checks in parallel with bounded timeouts:
 *   - db      SELECT 1 against Postgres           (2 s timeout) — critical
 *   - stellar GET to Stellar Horizon RPC          (3 s timeout) — soft
 *
 * Severity model (separates degraded readiness from hard liveness failure):
 *   - status "ok"          → HTTP 200, ready=true  (all checks pass)
 *   - status "degraded"    → HTTP 200, ready=true  (soft dep failed; keep traffic)
 *   - status "unavailable" → HTTP 503, ready=false (critical dep failed)
 *
 * Soft failures must NOT be treated as process/liveness failures. Use
 * GET /api/health/live for process restarts; use this probe for traffic.
 *
 * Response shape:
 *   200  { ok, status: "ok"|"degraded", ready: true,  checks, ts }
 *   503  { ok: false, status: "unavailable", ready: false, checks, ts }
 *
 * Headers:
 *   Cache-Control: no-store   (never cache health responses)
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  DEFAULT_HORIZON,
  resolveDbTimeoutMs,
  resolveStellarTimeoutMs,
  summarizeReadiness,
  withTimeout,
  type HealthChecks,
  type ReadinessStatus,
} from "../utils";

export const runtime = "nodejs";

export type CheckResult = "ok" | "error";
export type CheckName = "db" | "stellar";
export type { HealthChecks };

export interface HealthCheckResult {
  ok: boolean;
  status: ReadinessStatus;
  ready: boolean;
  checks: HealthChecks;
  ts: string;
}

export interface HealthCheckOptions {
  /** Database client, must support `.execute(query)` */
  db: Pick<typeof db, "execute">;
  /** Fetch-compatible function for making HTTP requests */
  fetch: typeof fetch;
  /** Clock function used for the response `ts` field */
  now: () => Date;
  /** Timeout for the database check */
  dbTimeoutMs: number;
  /** Timeout for the stellar check */
  stellarTimeoutMs: number;
  /** Horizon URL to check */
  stellarUrl: string;
}

/**
 * Run the readiness dependency checks with the provided options.
 * Exported separately to make the route deterministic and testable.
 */
export async function performHealthCheck(
  options: HealthCheckOptions,
): Promise<HealthCheckResult> {
  const {
    db,
    fetch,
    now,
    dbTimeoutMs,
    stellarTimeoutMs,
    stellarUrl,
  } = options;

  const checks: HealthChecks = {
    db: "error",
    stellar: "error",
  };

  await Promise.allSettled([
    withTimeout(
      (signal) => {
        void signal;
        return db.execute(sql`SELECT 1`);
      },
      dbTimeoutMs,
    ).then(() => {
      checks.db = "ok";
    }),
    withTimeout(
      (signal) =>
        fetch(stellarUrl, { signal }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        }),
      stellarTimeoutMs,
    ).then(() => {
      checks.stellar = "ok";
    }),
  ]);

  const summary = summarizeReadiness(checks);
  return {
    ok: summary.ok,
    status: summary.status,
    ready: summary.ready,
    checks,
    ts: now().toISOString(),
  };
}

export async function GET() {
  const result = await performHealthCheck({
    db,
    fetch,
    now: () => new Date(),
    dbTimeoutMs: resolveDbTimeoutMs(),
    stellarTimeoutMs: resolveStellarTimeoutMs(),
    stellarUrl: process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON,
  });

  const httpStatus = result.ready ? 200 : 503;

  return NextResponse.json(result, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" },
  });
}
