import { db as defaultDb } from "@/db";
import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_HORIZON,
  DB_TIMEOUT_MS,
  STELLAR_TIMEOUT_MS,
  withTimeout,
} from "./utils";

export const runtime = "nodejs";

type Db = {
  execute: (query: any) => Promise<any>;
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
export type HealthChecks = {
  db: DependencyStatus;
  stellar: DependencyStatus;
};

/**
 * Creates a health check handler for Next.js.
 *
 * The `probe` query parameter controls the behavior:
 * - `?probe=live`: liveness probe, always responds 200 as long as the
 *   process is running. It does not touch any dependencies.
 * - no `probe` (or any other value): readiness probe, checks all
 *   dependencies and responds 200 if healthy, or 503 with a `checks`
 *   object identifying which dependencies failed.
 *
 * Dependencies are checked with a hard timeout; the response is always
 * bounded by the configured timeout values and will never hang.
 *
 * @example
 * Liveness: GET /api/health?probe=live -> 200 { ok: true, ts: ... }
 * Readiness healthy: GET /api/health -> 200 { ok: true, checks: { db: "ok", stellar: "ok" }, ts: ... }
 * Readiness degraded: GET /api/health -> 503 { ok: false, checks: { db: "error", stellar: "ok" }, ts: ... }
 */
export function createHealthHandler({
  db,
  fetchFn,
  now = () => new Date(),
  dbTimeoutMs = DB_TIMEOUT_MS,
  stellarTimeoutMs = STELLAR_TIMEOUT_MS,
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

    // Readiness probe: checks dependencies and returns 503 if any is failing.
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

    const ok = checks.db === "ok" && checks.stellar === "ok";

    return NextResponse.json(
      { ok, checks, ts: now().toISOString() },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  };
}

export const GET = createHealthHandler({
  db: defaultDb,
  fetchFn: fetch,
});
