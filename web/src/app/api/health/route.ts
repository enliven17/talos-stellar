import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

export async function GET() {
  const checks: { db: "ok" | "error"; stellar: "ok" | "error" } = {
    db: "error",
    stellar: "error",
  };

  await Promise.allSettled([
    withTimeout(db.execute(sql`SELECT 1`), 2000).then(() => {
      checks.db = "ok";
    }),
    withTimeout(
      fetch(process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }),
      3000,
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
