import { Pool } from "pg";

const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

export async function GET() {
  const start = Date.now();

  // Check database
  let dbOk = false;
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query("SELECT 1");
    await pool.end();
    dbOk = true;
  } catch (err) {
    dbOk = false;
  }

  // Check Stellar Horizon
  const horizonUrl = process.env.STELLAR_HORIZON_URL ?? DEFAULT_HORIZON;
  let stellarOk = false;
  try {
    const res = await fetch(horizonUrl, { method: "GET" });
    stellarOk = res.ok;
  } catch (err) {
    stellarOk = false;
  }

  const elapsed = Date.now() - start;

  const overall = dbOk && stellarOk ? "ok" : "degraded";
  const statusCode = dbOk && stellarOk ? 200 : 503;

  const body = {
    status: overall,
    database: { ok: dbOk },
    stellar: { ok: stellarOk, horizon: horizonUrl },
    timestamp: new Date().toISOString(),
    response_time_ms: elapsed,
  };

  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}
