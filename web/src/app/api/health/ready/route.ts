/**
 * GET /api/health/ready — Readiness probe
 *
 * Answers: "Is the service ready to accept traffic?"
 * Runs all dependency checks in parallel with bounded timeouts:
 *   - db      SELECT 1 against Postgres           (2 s timeout)
 *   - stellar GET to Stellar Horizon RPC           (3 s timeout)
 *
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

export async function GET() {
  const checks: { db: "ok" | "error"; stellar: "ok" | "error" } = {
    db: "error",
    stellar: "error",
  };

  await Promise.allSettled([
    withTimeout(db.execute(sql`SELECT 1`), DB_TIMEOUT_MS).then(() => {
      checks.db = "ok";
    }),
    withTimeout(
      fetch(process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
      STELLAR_TIMEOUT_MS,
    ).then(() => {
      checks.stellar = "ok";
    }),
  ]);

  const ok = checks.db === "ok" && checks.stellar === "ok";

  return NextResponse.json(
    { ok, checks, ts: new Date().toISOString() },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
