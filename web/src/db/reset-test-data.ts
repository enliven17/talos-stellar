/**
 * CLI entry point: safe local test-data reset (issue #629).
 *
 *   pnpm --dir web run db:reset-test-data --dry-run
 *   pnpm --dir web run db:reset-test-data --yes --seed
 *
 * All validation, safety checks, and output live in
 * `src/lib/local-test-data-reset.ts`; this file only wires the process-level
 * dependencies (env loading, pg pool, seed subprocess, stdio).
 */

import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import {
  redactSecrets,
  runReset,
  type ResetClient,
  type ResetDeps,
  type ResetTarget,
} from "../lib/local-test-data-reset";

// `pnpm stack:reset-data` exports DATABASE_URL itself; when the command is run
// directly, load `web/.env.local` (Next.js precedence) and then `web/.env`.
// Already-exported variables always win, so an explicit override is respected.
loadEnv({ path: [".env.local", ".env"], quiet: true });

let activePool: Pool | undefined;

/** Runs one of the package's own db scripts, so seeding keeps one source of truth. */
function runPnpmScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", script], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (error) => {
      reject(new Error(`could not start \`pnpm run ${script}\`: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`pnpm run ${script}\` exited with code ${code ?? "unknown"}`));
    });
  });
}

const deps: ResetDeps = {
  async createClient(target: ResetTarget): Promise<ResetClient> {
    const pool = new Pool({
      connectionString: target.url,
      max: 1,
      application_name: "talos-reset-test-data",
      // Bound both sides: a refused connection must fail loudly instead of hanging.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 20_000,
    });
    activePool = pool;
    try {
      // `Pool` connects lazily, so without this probe an unreachable database
      // would surface after the retry loop instead of inside it.
      await pool.query("SELECT 1");
    } catch (error) {
      activePool = undefined;
      await pool.end().catch(() => {});
      throw error;
    }
    return {
      query: async (sql, params) => pool.query(sql, params ? [...params] : undefined),
    };
  },

  async closeClient(): Promise<void> {
    const pool = activePool;
    activePool = undefined;
    if (pool) await pool.end();
  },

  runSeed: () => runPnpmScript("db:seed"),

  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),

  log: (line: string) => console.log(line),

  // Messages from the library already identify the command; only redaction is
  // applied here so nothing credential-shaped can slip through.
  logError: (line: string) => console.error(redactSecrets(line)),
};

runReset(process.argv.slice(2), deps)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`db:reset-test-data: unexpected failure: ${redactSecrets(error)}`);
    process.exitCode = 1;
  });
