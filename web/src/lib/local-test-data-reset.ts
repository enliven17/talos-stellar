/**
 * Safe local test-data reset (issue #629).
 *
 * Single source of truth for the reset behavior, shared by:
 *   - `pnpm --dir web run db:reset-test-data`   (direct, uses DATABASE_URL)
 *   - `pnpm stack:reset-data`                   (docker compose local stack)
 *
 * Contract:
 *   - Only ever mutates a *provably local* Postgres database. The target host
 *     must be loopback; anything else is refused. There is no override flag.
 *   - The table set comes from `src/db/schema.ts` (drizzle models), never from a
 *     hand-maintained list, so schema and reset can not drift apart.
 *   - Never logs or returns connection strings, passwords, seeds, payment
 *     proofs, or row contents. Only database name, host, table names, and row
 *     *counts* are ever printed.
 *   - Fails closed on missing, malformed, ambiguous, or unsupported input and
 *     on dependency failures (unreachable DB, unmigrated DB, seed failure).
 *     A failure never reports success.
 *
 * Schema is not touched: tables are truncated, never dropped or altered, and the
 * `drizzle` migrations schema is out of scope entirely.
 */

import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";

// ─── Errors ───────────────────────────────────────────────────────────

export type ResetErrorCode =
  | "hosted_context"
  | "missing_database_url"
  | "malformed_database_url"
  | "non_local_target"
  | "target_mismatch"
  | "confirmation_required"
  | "unknown_argument"
  | "unsafe_table_name"
  | "empty_plan"
  | "missing_tables"
  | "connect_failed"
  | "reset_failed"
  | "seed_failed";

export class ResetError extends Error {
  readonly code: ResetErrorCode;

  constructor(code: ResetErrorCode, message: string) {
    super(message);
    this.name = "ResetError";
    this.code = code;
  }
}

// ─── Privacy helpers ──────────────────────────────────────────────────

const REDACTED = "[redacted]";

/**
 * Renders a connection URL for humans without ever echoing credentials.
 * Produces `postgresql://user@host:port/database` — password and every query
 * parameter (which can carry credentials or pooler tokens) are dropped.
 * Returns a fixed placeholder when the URL cannot be parsed: raw input is
 * never surfaced.
 */
export function redactDatabaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") return "(unset)";
  try {
    const url = new URL(raw.trim());
    const user = url.username ? `${url.username}@` : "";
    const port = url.port ? `:${url.port}` : "";
    const database = url.pathname.replace(/^\//, "");
    return `${url.protocol}//${user}${url.hostname}${port}/${database}`;
  } catch {
    return "(unparseable database url)";
  }
}

const CREDENTIAL_IN_URL = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;
const ASSIGNED_SECRET =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|mnemonic|seed)\b\s*[=:]\s*[^\s,;]+/gi;
const KEY_MATERIAL = /\b[A-Za-z0-9+/]{64,}={0,2}\b|\b[0-9a-fA-F]{64,}\b/g;

/**
 * Sanitises arbitrary error text (driver messages, stack frames) so that
 * credentials, key material, and seed phrases never reach an operator's
 * terminal or a CI log.
 */
export function redactSecrets(message: unknown, maxLen = 300): string {
  if (message === null || message === undefined) return "unknown error";
  let text: string;
  if (typeof message === "string") text = message;
  else if (message instanceof Error) text = message.message;
  else {
    try {
      text = JSON.stringify(message);
    } catch {
      text = String(message);
    }
  }
  text = text
    .replace(CREDENTIAL_IN_URL, `$1${REDACTED}@`)
    .replace(ASSIGNED_SECRET, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(KEY_MATERIAL, REDACTED)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return text || "unknown error";
}

// ─── Argument parsing ─────────────────────────────────────────────────

export interface ResetOptions {
  /** `--yes`: explicit acknowledgement that local rows will be destroyed. */
  confirmed: boolean;
  /** `--dry-run`: report the plan and row counts, change nothing. */
  dryRun: boolean;
  /** `--seed`: re-run the canonical seed after truncating. */
  seed: boolean;
  /** `--help` / `-h`. */
  help: boolean;
}

export const USAGE = [
  "Usage: pnpm --dir web run db:reset-test-data [options]",
  "",
  "Truncates the local Talos tables and (optionally) re-runs the canonical seed.",
  "Only runs against a loopback Postgres host (localhost / 127.0.0.0-8 / ::1).",
  "",
  "Options:",
  "  --dry-run   Print the affected tables and row counts; change nothing.",
  "  --seed      Re-run `db:seed` after truncating.",
  "  --yes       Required to actually truncate. Fail closed without it.",
  "  --help, -h  Print this message.",
  "",
  "Examples:",
  "  pnpm --dir web run db:reset-test-data --dry-run",
  "  pnpm --dir web run db:reset-test-data --yes --seed",
  "  pnpm stack:reset-data --yes            # docker compose local stack",
].join("\n");

/**
 * Strictly parses flags. Any positional argument, `--flag=value` form, or
 * unrecognised flag is refused rather than ignored: ambiguous input must never
 * silently select a different behavior.
 */
export function parseResetArgs(argv: readonly string[]): ResetOptions {
  const options: ResetOptions = {
    confirmed: false,
    dryRun: false,
    seed: false,
    help: false,
  };

  for (const raw of argv) {
    switch (raw) {
      case "--yes":
        options.confirmed = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--seed":
        options.seed = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new ResetError(
          "unknown_argument",
          `Unrecognised argument ${JSON.stringify(raw)}. Supported flags: --dry-run, --seed, --yes, --help.`,
        );
    }
  }

  return options;
}

// ─── Target validation ────────────────────────────────────────────────

const HOSTED_CONTEXT_MARKERS = ["VERCEL_ENV", "RAILWAY_ENVIRONMENT", "RAILWAY_PROJECT_ID"] as const;

const DEFAULT_POSTGRES_PORT = 5432;
const LOOPBACK_HOSTS = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "") return false;
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  return IPV4_LOOPBACK.test(normalized);
}

export interface ResetTarget {
  /** Full connection URL. Never logged, never returned in output. */
  url: string;
  /** Credential-free rendering safe to print. */
  display: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

/**
 * Resolves and validates the reset target.
 *
 * Precedence mirrors the running app (`src/db/index.ts` uses `DATABASE_URL`):
 * `DATABASE_URL` wins and `DIRECT_URL` is only consulted when it is absent, so
 * a stale remote `DIRECT_URL` in `.env.local` can never redirect the reset.
 * Whichever variable is used must be local, or the command refuses.
 */
export function resolveResetTarget(env: Record<string, string | undefined>): ResetTarget {
  for (const marker of HOSTED_CONTEXT_MARKERS) {
    if (env[marker]) {
      throw new ResetError(
        "hosted_context",
        `Refusing to run: ${marker} is set, which indicates a hosted deployment rather than a local checkout.`,
      );
    }
  }
  if (env.NODE_ENV === "production") {
    throw new ResetError(
      "hosted_context",
      "Refusing to run: NODE_ENV=production. This command only resets local test data.",
    );
  }

  const raw = (env.DATABASE_URL ?? "").trim() || (env.DIRECT_URL ?? "").trim();
  const source = (env.DATABASE_URL ?? "").trim() ? "DATABASE_URL" : "DIRECT_URL";

  if (!raw) {
    throw new ResetError(
      "missing_database_url",
      "DATABASE_URL is not set. Export it, or use `pnpm stack:reset-data` to target the docker compose database.",
    );
  }

  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    throw new ResetError(
      "malformed_database_url",
      `${source} must be a postgres:// or postgresql:// URL.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ResetError(
      "malformed_database_url",
      `${source} is not a valid URL (it was not echoed here to avoid leaking credentials).`,
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) {
    throw new ResetError("malformed_database_url", `${source} does not name a host.`);
  }

  if (!parsed.username) {
    throw new ResetError(
      "malformed_database_url",
      `${source} does not name a user (expected user:password@host:port/database). An implicit OS user is ambiguous, so it is refused.`,
    );
  }

  // `new URL()` already throws for non-numeric and out-of-range ports; this
  // only rejects ports that parse but cannot address a database.
  const port = parsed.port === "" ? DEFAULT_POSTGRES_PORT : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ResetError("malformed_database_url", `${source} does not have a valid port.`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) {
    throw new ResetError(
      "malformed_database_url",
      `${source} does not name a database (expected .../<database>).`,
    );
  }

  if (!isLoopbackHost(host)) {
    throw new ResetError(
      "non_local_target",
      `Refusing to reset database "${database}" on non-local host "${host}". This command only targets localhost, 127.0.0.0/8, or ::1.`,
    );
  }

  return {
    url: raw,
    display: redactDatabaseUrl(raw),
    host,
    port,
    database,
    user: parsed.username,
  };
}

// ─── Reset plan ───────────────────────────────────────────────────────

/** Table names modelled in `src/db/schema.ts` — the single source of truth. */
export function managedTables(): string[] {
  // The schema module is a bag of concrete table types; widening to `unknown`
  // first is what lets `is(value, PgTable)` act as a predicate (a predicate type
  // must be assignable to the narrow union it filters).
  const exported: unknown[] = Object.values(schema);
  return exported
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))
    .sort();
}

export function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new ResetError(
      "unsafe_table_name",
      `Refusing to reset: table name ${JSON.stringify(identifier)} is not a plain lowercase identifier.`,
    );
  }
  return `"${identifier}"`;
}

/**
 * Builds the single destructive statement. `CASCADE` is safe here because every
 * dependent table is in the same managed set; `RESTART IDENTITY` keeps local
 * sequences tidy. The statement is never `DROP`/`DELETE` and never touches the
 * `drizzle` migrations schema.
 */
export function buildTruncateStatement(tables: readonly string[]): string {
  if (tables.length === 0) {
    throw new ResetError("empty_plan", "Refusing to reset: no tables resolved from the schema.");
  }
  const identifiers = [...new Set(tables)].sort().map(quoteIdent);
  return `TRUNCATE TABLE ${identifiers.join(", ")} RESTART IDENTITY CASCADE`;
}

export interface ResetPlan {
  database: string;
  tables: string[];
  rowCounts: Array<{ table: string; rows: number }>;
  totalRows: number;
}

// ─── Client contract ──────────────────────────────────────────────────

export interface ResetQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface ResetClient {
  query(sql: string, params?: readonly unknown[]): Promise<ResetQueryResult>;
}

export interface ResetDeps {
  /**
   * Must resolve only once the database is actually reachable, so that
   * `withConnectRetry` covers the whole connect path (a lazily connecting pool
   * would surface the failure after the retry loop instead of inside it).
   */
  createClient(target: ResetTarget): Promise<ResetClient>;
  closeClient(client: ResetClient): Promise<void>;
  /** Runs the canonical `db:seed` script. Injected so tests never spawn. */
  runSeed(): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  logError(line: string): void;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08006",
  "57P03",
]);

export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /connection terminated|server closed the connection|the database system is starting up/i.test(
    message,
  );
}

/**
 * Bounded retry around the initial connection. A freshly started local stack
 * (`pnpm stack:up`) usually accepts connections within a second or two, and the
 * dependency-failure path must be explicit rather than silently succeeding.
 */
export async function withConnectRetry<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isTransientConnectionError(error) || i === attempts) break;
      await options.sleep(baseDelayMs * i);
    }
  }

  throw lastError;
}

// ─── Execution ────────────────────────────────────────────────────────

async function readCurrentDatabase(client: ResetClient): Promise<string> {
  const result = await client.query("SELECT current_database() AS database");
  const value = result.rows[0]?.database;
  return typeof value === "string" ? value : "";
}

async function readPublicTables(client: ResetClient): Promise<string[]> {
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows
    .map((row) => row.tablename)
    .filter((name): name is string => typeof name === "string");
}

async function readRowCount(client: ResetClient, table: string): Promise<number> {
  const result = await client.query(`SELECT count(*)::int AS row_count FROM ${quoteIdent(table)}`);
  const value = result.rows[0]?.row_count;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves the tables to truncate. Refuses when the database is missing any
 * modelled table, which is the signature of an unmigrated or partially migrated
 * database: resetting it would silently do nothing useful.
 */
export async function buildResetPlan(
  client: ResetClient,
  database: string,
): Promise<ResetPlan> {
  const managed = managedTables();
  if (managed.length === 0) {
    throw new ResetError(
      "empty_plan",
      "No tables resolved from src/db/schema.ts — refusing to run.",
    );
  }

  const existing = new Set(await readPublicTables(client));
  const missing = managed.filter((table) => !existing.has(table));

  if (missing.length === managed.length) {
    throw new ResetError(
      "missing_tables",
      "No Talos tables found in this database. Run `pnpm --dir web run db:migrate` first.",
    );
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 8).join(", ");
    const suffix = missing.length > 8 ? `, … (${missing.length} total)` : "";
    throw new ResetError(
      "missing_tables",
      `Database is missing modelled tables: ${shown}${suffix}. Run \`pnpm --dir web run db:migrate\` first.`,
    );
  }

  const rowCounts: Array<{ table: string; rows: number }> = [];
  for (const table of managed) {
    rowCounts.push({ table, rows: await readRowCount(client, table) });
  }

  return {
    database,
    tables: managed,
    rowCounts,
    totalRows: rowCounts.reduce((sum, entry) => sum + entry.rows, 0),
  };
}

/**
 * Runs the full reset workflow and returns the process exit code (0 ok, 1
 * failure). Every failure path returns 1 and prints an explicit, privacy-safe
 * reason — never a partial "done".
 */
export async function runReset(
  argv: readonly string[],
  deps: ResetDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const started = Date.now();

  const fail = (error: unknown): number => {
    if (error instanceof ResetError) {
      deps.logError(`db:reset-test-data: ${error.message}`);
      if (error.code === "confirmation_required" || error.code === "unknown_argument") {
        deps.logError("Run with --help for usage.");
      }
      return 1;
    }
    deps.logError(`db:reset-test-data: unexpected failure: ${redactSecrets(error)}`);
    return 1;
  };

  let options: ResetOptions;
  try {
    options = parseResetArgs(argv);
  } catch (error) {
    return fail(error);
  }

  if (options.help) {
    deps.log(USAGE);
    return 0;
  }

  if (!options.confirmed && !options.dryRun) {
    return fail(
      new ResetError(
        "confirmation_required",
        "Refusing to delete local test data without --yes (or use --dry-run to preview).",
      ),
    );
  }

  let target: ResetTarget;
  try {
    target = resolveResetTarget(env);
  } catch (error) {
    return fail(error);
  }

  let client: ResetClient | undefined;
  try {
    // `display` is the credential-free rendering: this is the only form of the
    // connection string that ever reaches the terminal.
    deps.log(
      `${options.dryRun ? "Dry run against" : "Targeting"} ${target.database} on ${target.host}:${target.port} (${target.display})`,
    );

    client = await withConnectRetry(() => deps.createClient(target), {
      sleep: deps.sleep,
    });

    // Confirm the server we reached is the database the URL named. A pooler or
    // proxy that rewrites the target must not turn into a silent reset of
    // something else.
    const connectedDatabase = await readCurrentDatabase(client);
    if (connectedDatabase && connectedDatabase !== target.database) {
      throw new ResetError(
        "target_mismatch",
        `Connected to database "${connectedDatabase}" but the URL named "${target.database}". Refusing to reset.`,
      );
    }

    const plan = await buildResetPlan(client, target.database);
    deps.log(
      `Plan: ${plan.tables.length} tables, ${plan.totalRows} row(s) currently present.`,
    );

    if (options.dryRun) {
      deps.log("Dry run complete: no data was changed.");
      return 0;
    }

    await client.query(buildTruncateStatement(plan.tables));
    deps.log(`Truncated ${plan.tables.length} tables.`);

    if (options.seed) {
      try {
        await deps.runSeed();
        deps.log("Re-seeded from the canonical seed script.");
      } catch (error) {
        throw new ResetError(
          "seed_failed",
          `Reset succeeded but seeding failed: ${redactSecrets(error)}. Re-run \`pnpm --dir web run db:seed\`.`,
        );
      }
    }

    deps.log(
      `Reset complete in ${Date.now() - started}ms${options.seed ? "" : " (database is now empty; add --seed to repopulate)"}.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ResetError) return fail(error);
    const code = (error as { code?: string } | null)?.code;
    const wrapped =
      isTransientConnectionError(error) || code === "28P01" || code === "28000"
        ? new ResetError(
            "connect_failed",
            `Could not reach ${target.host}:${target.port} — ${redactSecrets(error)}. Is the local database running? Try \`pnpm stack:up\`.`,
          )
        : new ResetError("reset_failed", redactSecrets(error));
    return fail(wrapped);
  } finally {
    if (client) {
      try {
        await deps.closeClient(client);
      } catch {
        // Closing failures must not mask the real outcome.
      }
    }
  }
}
