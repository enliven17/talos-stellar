import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  DEFAULT_HORIZON,
  DB_TIMEOUT_MS,
  STELLAR_TIMEOUT_MS,
  withTimeout,
} from "./utils";

export const runtime = "nodejs";

export async function GET() {
  const checks: { db: "ok" | "error"; stellar: "ok" | "error" } = {
    db: "error",
    stellar: "error",
  };

  await Promise.allSettled([
    withTimeout(
      (signal) => {
        void signal;
        return db.execute(sql`SELECT 1`);
      },
      DB_TIMEOUT_MS,
    ).then(() => {
      checks.db = "ok";
    }),
    withTimeout(
      (signal) =>
        fetch(process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON, { signal }).then((r) => {
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
