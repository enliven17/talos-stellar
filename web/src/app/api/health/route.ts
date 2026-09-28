import { db as defaultDb } from "@/db";
import { sql, type SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_HORIZON,
  resolveDbTimeoutMs,
  resolveStellarTimeoutMs,
  summarizeReadiness,
  withTimeout,
  type HealthChecks,
} from "./utils";

export const runtime = "nodejs";

type Db = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * Health check dependencies that can be injected for testing.
 */
export type HealthDeps = {
  db: Db;
  fetchFn: typeof fetch;
  now?: () => Date;
  dbTimeoutMs?: number;
  stellarTimeoutMs?: number;
};

/**
 * The readiness state of a single dependency. Only "ok" or "error" is
 * reported; no internal error details or connection strings are exposed.
 */
export type DependencyStatus = "ok" | "error";

/**
 * Readiness check results with one entry per dependency.
 */
export type { HealthChecks };

/**
 * Creates a health check handler for Next.js.
 *
 * The `probe` query parameter controls the behavior:
 * - `?probe=live`: liveness probe, always responds 200 as long as the
 *   process is running. It does not touch any dependencies.
 * - no `probe` (or any other value): readiness probe. Critical dependency
 *   failures (`db`) yield HTTP 503 / `status: "unavailable"`. Soft
 *   dependency failures alone (`stellar`) yield HTTP 200 /
 *   `status: "degraded"` so orchestrators do not treat them as a hard
 *   liveness / process failure.
 *
 * Dependencies are checked with a hard timeout; the response is always
 * bounded by the configured timeout values and will never hang.
 *
 * @example
 * Liveness: GET /api/health?probe=live -> 200 { ok: true, ts: ... }
 * Healthy: GET /api/health -> 200 { ok: true, status: "ok", ready: true, checks: {...}, ts: ... }
 * Degraded (Horizon down): GET /api/health -> 200 { ok: false, status: "degraded", ready: true, checks: { db: "ok", stellar: "error" }, ts: ... }
 * Unavailable (DB down): GET /api/health -> 503 { ok: false, status: "unavailable", ready: false, checks: { db: "error", stellar: "ok" }, ts: ... }
 */
export function createHealthHandler({
  db,
  fetchFn,
  now = () => new Date(),
  dbTimeoutMs = resolveDbTimeoutMs(),
  stellarTimeoutMs = resolveStellarTimeoutMs(),
}: HealthDeps) {
  return async function GET(request: NextRequest) {
    const probe = request.nextUrl.searchParams.get("probe");

    // Liveness probe: always 200 if the process is running.
    if (probe === "live") {
      return NextResponse.json(
        { ok: true, ts: now().toISOString() },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Readiness probe: separate degraded (soft) from unavailable (critical).
    const checks: HealthChecks = {
      db: "error",
      stellar: "error",
    };

    await Promise.allSettled([
      withTimeout((signal) => {
        void signal;
        return db.execute(sql`SELECT 1`);
      }, dbTimeoutMs).then(() => {
        checks.db = "ok";
      }),
      withTimeout(
        (signal) =>
          fetchFn(process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON, { signal }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
          }),
        stellarTimeoutMs,
      ).then(() => {
        checks.stellar = "ok";
      }),
    ]);

    const summary = summarizeReadiness(checks);

    return NextResponse.json(
      {
        ok: summary.ok,
        status: summary.status,
        ready: summary.ready,
        checks,
        ts: now().toISOString(),
      },
      { status: summary.httpStatus, headers: { "Cache-Control": "no-store" } },
    );
  };
}

export const GET = createHealthHandler({
  db: defaultDb,
  // Resolve the global at call time so instrumented/stubbed fetch is honoured.
  fetchFn: (input, init) => fetch(input, init),
});
