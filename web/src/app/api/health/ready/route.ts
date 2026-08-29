/** * GET /api/health/ready - Readiness probe

 *
 * Answers: "Is the service ready to accept traffic?"
 * Runs all dependency checks in parallel with bounded timeouts:
 *   - db      SELECT 1 against Postgres           (2 s timeout)
 *   - stellar GET to Stellar Horizon RPC          (3 s timeout)

 * Use this probe for:
 *   - Kubernetes readinessProbe (remove pod from load-balancer when degraded)
 *   - UptimeRobot / Better Uptime monitoring (1-minute interval)
 *
 * A readiness failure means a dependency is down; the process stays alive
 * but should not receive traffic.  The liveness probe (GET /api/health/live)
 * is unaffected.
 *
 * Response shape:
 *   200  { ok: true,  checks: { db: "ok",    stellar: "ok"    }, ts: <ISO> }
 *   503  { ok: false, checks: { db: "error", stellar: "ok"    }, ts: <ISO> }
 *
 * Headers:
 *   Cache-Control: no-store   (never cache health responses)
 *
 * Each dependency check is bound by a timeout; if it exceeds the timeout
 * the check is reported as "error" within that bound.
 */

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  DEFAULT_HORIZON,
  DB_TIMEOUT_MS,
  STELLAR_TIMEOUT_MS,
  withTimeout,
} from "../utils";

export const runtime = "nodejs";

type CheckResult = "ok" | "error";
type CheckName = "db" | "stellar";
type HealthChecks = Record<CheckName, CheckResult>;

interface HealthCheckResult {
  ok: boolean;
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
  /** Horezon URL to check */
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

  const ok = checks.db === "ok" && checks.stellar === "ok";
  return { ok, checks, ts: now().toISOString() };
}

export async function GET() {
  const result = await performHealthCheck({
    db,
    fetch,
    now: () => new Date(),
    dbTimeoutMs: DB_TIMEOUT_MS,
    stellarTimeoutMs: STELLAR_TIMEOUT_MS,
    stellarUrl: process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON,
  });

  return NextResponse.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
