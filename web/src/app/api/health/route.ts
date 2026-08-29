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

type HealthDeps = {
  db: Db;
  fetchFn: typeof fetch;
  now?: () => Date;
  dbTimeoutMs?: number;
  stellarTimeoutMs?: number;
};

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
    const checks: { db: "ok" | "error"; stellar: "ok" | "error" } = {
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
