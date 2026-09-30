/**
 * Focused coverage for the safe local test-data reset (`db:reset-test-data`, #629).
 *
 * Positive:   argument parsing, schema-derived plan, truncate + optional seed.
 * Negative:   fail-closed on missing/malformed/ambiguous input, hosted contexts,
 *             non-local hosts, unmigrated databases, connection and seed failures.
 * Boundary:   loopback allowlist edges, DIRECT_URL fallback, retry behavior,
 *             idempotent statement shape (no DROP/DELETE, migrations untouched).
 * Regression: no credentials, seeds, or key material ever reach the output.
 *
 * No database is required: the client and seeder are injected.
 *
 * Local command:
 *   pnpm --dir web exec vitest run tests/local-test-data-reset.unit.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  buildTruncateStatement,
  isLoopbackHost,
  managedTables,
  parseResetArgs,
  quoteIdent,
  redactDatabaseUrl,
  redactSecrets,
  resolveResetTarget,
  runReset,
  withConnectRetry,
  ResetError,
  type ResetClient,
  type ResetDeps,
} from "../src/lib/local-test-data-reset";

const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:5432/talos";
const LOCAL_ENV = { DATABASE_URL: LOCAL_URL };

interface HarnessOptions {
  /** Tables the fake database reports. Defaults to every modelled table. */
  existingTables?: string[];
  rowsPerTable?: number;
  /** What `current_database()` reports. Defaults to "talos". */
  currentDatabase?: string;
  /** Thrown by `createClient` on every attempt. */
  createError?: unknown;
  /** Thrown by the injected seeder. */
  seedError?: unknown;
}

interface Harness {
  deps: ResetDeps;
  queries: string[];
  logs: string[];
  errors: string[];
  created: number;
  closed: number;
  seeds: number;
  sleeps: number[];
}

function harness(options: HarnessOptions = {}): Harness {
  const queries: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  const exists = options.existingTables ?? managedTables();
  const rowsPerTable = options.rowsPerTable ?? 2;
  const state = { created: 0, closed: 0, seeds: 0 };

  const client: ResetClient = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("current_database")) {
        return { rows: [{ database: options.currentDatabase ?? "talos" }] };
      }
      if (sql.includes("pg_tables")) {
        return { rows: exists.map((tablename) => ({ tablename })) };
      }
      const counted = /FROM "([a-z0-9_]+)"/.exec(sql);
      if (counted) return { rows: [{ row_count: rowsPerTable }] };
      return { rows: [] };
    },
  };

  const deps: ResetDeps = {
    async createClient() {
      state.created += 1;
      if (options.createError) throw options.createError;
      return client;
    },
    async closeClient() {
      state.closed += 1;
    },
    async runSeed() {
      state.seeds += 1;
      if (options.seedError) throw options.seedError;
    },
    async sleep(ms: number) {
      sleeps.push(ms);
    },
    log: (line: string) => logs.push(line),
    logError: (line: string) => errors.push(line),
  };

  return {
    deps,
    queries,
    logs,
    errors,
    sleeps,
    get created() {
      return state.created;
    },
    get closed() {
      return state.closed;
    },
    get seeds() {
      return state.seeds;
    },
  };
}

const truncates = (h: Harness) => h.queries.filter((sql) => sql.startsWith("TRUNCATE"));
const output = (h: Harness) => [...h.logs, ...h.errors].join("\n");

/** Runs `fn` and reports the ResetError code it refused with, if any. */
function resetErrorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ResetError ? error.code : undefined;
  }
}

// ─── Positive ─────────────────────────────────────────────────────────

describe("local test-data reset (positive)", () => {
  it("resolves the plan from src/db/schema.ts, not a hand-maintained list", () => {
    const tables = managedTables();
    expect(tables).toContain("tls_talos");
    expect(tables).toContain("tls_patrons");
    expect(tables).toContain("tls_commerce_jobs");
    expect(tables).toContain("tls_playbook_purchases");
    expect(tables).toContain("tls_consumed_nonces");
    expect(tables.every((table) => table.startsWith("tls_"))).toBe(true);
    expect(new Set(tables).size).toBe(tables.length);
    // Sorted, so statement and logs are stable across runs.
    expect([...tables].sort()).toEqual(tables);
  });

  it("parses supported flags and rejects everything else", () => {
    expect(parseResetArgs(["--yes", "--seed", "--dry-run"])).toEqual({
      confirmed: true,
      dryRun: true,
      seed: true,
      help: false,
    });
    expect(parseResetArgs(["-h"]).help).toBe(true);
    expect(parseResetArgs([])).toEqual({
      confirmed: false,
      dryRun: false,
      seed: false,
      help: false,
    });
  });

  it("prints usage for --help without touching any database", async () => {
    const h = harness();
    expect(await runReset(["--help"], h.deps, LOCAL_ENV)).toBe(0);
    expect(h.created).toBe(0);
    expect(h.logs.join("\n")).toContain("db:reset-test-data");
  });

  it("truncates exactly once, covering every modelled table, and reports counts", async () => {
    const h = harness({ rowsPerTable: 3 });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(0);

    const statements = truncates(h);
    expect(statements).toHaveLength(1);
    for (const table of managedTables()) {
      expect(statements[0]).toContain(`"${table}"`);
    }
    expect(output(h)).toContain(`${managedTables().length} tables`);
    expect(h.seeds).toBe(0);
    expect(h.closed).toBe(1);
  });

  it("re-runs the canonical seed only when --seed is passed", async () => {
    const withSeed = harness();
    expect(await runReset(["--yes", "--seed"], withSeed.deps, LOCAL_ENV)).toBe(0);
    expect(withSeed.seeds).toBe(1);

    const withoutSeed = harness();
    expect(await runReset(["--yes"], withoutSeed.deps, LOCAL_ENV)).toBe(0);
    expect(withoutSeed.seeds).toBe(0);
  });

  it("dry run reports the plan and changes nothing", async () => {
    const h = harness({ rowsPerTable: 7 });
    expect(await runReset(["--dry-run"], h.deps, LOCAL_ENV)).toBe(0);
    expect(truncates(h)).toHaveLength(0);
    expect(h.seeds).toBe(0);
    expect(output(h)).toContain("no data was changed");
  });
});

// ─── Negative / fail-closed ───────────────────────────────────────────

describe("local test-data reset (fail closed)", () => {
  it("refuses without --yes and never connects", async () => {
    const h = harness();
    expect(await runReset([], h.deps, LOCAL_ENV)).toBe(1);
    expect(h.created).toBe(0);
    expect(h.queries).toHaveLength(0);
    expect(h.errors.join("\n")).toContain("--yes");
  });

  it("refuses positional and unknown arguments without connecting", async () => {
    for (const argv of [["talos"], ["--yes", "--force"], ["--yes=true"]]) {
      const h = harness();
      expect(await runReset(argv, h.deps, LOCAL_ENV)).toBe(1);
      expect(h.created).toBe(0);
      expect(h.errors.join("\n")).toContain("Unrecognised argument");
    }
  });

  it("refuses when DATABASE_URL is missing", async () => {
    const h = harness();
    expect(await runReset(["--yes"], h.deps, {})).toBe(1);
    expect(h.created).toBe(0);
    expect(h.errors.join("\n")).toContain("DATABASE_URL is not set");
  });

  it("refuses non-postgres, user-less, database-less, and bad-port URLs", async () => {
    const cases: Array<[string, RegExp]> = [
      ["mysql://user:pw@127.0.0.1:3306/talos", /must be a postgres/],
      ["postgresql://127.0.0.1:5432/talos", /does not name a user/],
      ["postgresql://postgres@127.0.0.1:5432", /does not name a database/],
      ["postgresql://postgres@127.0.0.1:0/talos", /valid port/],
      // Out-of-range and non-numeric ports do not parse: refuse, never silently
      // fall back to 5432.
      ["postgresql://postgres@127.0.0.1:99999/talos", /not a valid URL/],
      ["postgresql://postgres@127.0.0.1:abc/talos", /not a valid URL/],
      ["not a url at all", /must be a postgres/],
      ["", /DATABASE_URL is not set/],
    ];
    for (const [url, expected] of cases) {
      const h = harness();
      expect(await runReset(["--yes"], h.deps, { DATABASE_URL: url })).toBe(1);
      expect(h.created).toBe(0);
      expect(output(h)).toMatch(expected);
    }
  });

  it("refuses remote hosts (the production footgun) without connecting", async () => {
    const remote = [
      "postgresql://postgres.abcdef:secretpw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
      "postgresql://postgres:pw@db.example.supabase.co:5432/postgres",
      "postgresql://postgres:pw@prod-db.internal:5432/talos",
      "postgresql://postgres:pw@127.0.0.1.evil.example:5432/talos",
      "postgresql://postgres:pw@0.0.0.0:5432/talos",
    ];
    for (const url of remote) {
      const h = harness();
      expect(await runReset(["--yes"], h.deps, { DATABASE_URL: url })).toBe(1);
      expect(h.created).toBe(0);
      expect(h.errors.join("\n")).toContain("non-local host");
      expect(h.errors.join("\n")).not.toContain("secretpw");
    }
  });

  it("refuses hosted deployment contexts", async () => {
    for (const marker of [
      { NODE_ENV: "production" },
      { VERCEL_ENV: "production" },
      { RAILWAY_ENVIRONMENT: "production" },
    ]) {
      const h = harness();
      expect(await runReset(["--yes"], h.deps, { DATABASE_URL: LOCAL_URL, ...marker })).toBe(1);
      expect(h.created).toBe(0);
      expect(h.errors.join("\n")).toContain("Refusing to run");
    }
  });

  it("refuses when the server reports a different database than the URL named", async () => {
    const h = harness({ currentDatabase: "talos_prod" });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(1);
    expect(truncates(h)).toHaveLength(0);
    expect(output(h)).toContain("Refusing to reset");
  });

  it("refuses an unmigrated database and truncates nothing", async () => {
    const h = harness({ existingTables: [] });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(1);
    expect(truncates(h)).toHaveLength(0);
    expect(h.errors.join("\n")).toContain("db:migrate");
    // The connection was opened, so it must be released on the failure path.
    expect(h.closed).toBe(1);
  });

  it("refuses a partially migrated database", async () => {
    const h = harness({ existingTables: ["tls_talos", "tls_patrons"] });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(1);
    expect(truncates(h)).toHaveLength(0);
    expect(h.errors.join("\n")).toContain("missing modelled tables");
  });

  it("reports an unreachable database explicitly and truncates nothing", async () => {
    const h = harness({ createError: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(1);
    expect(h.errors.join("\n")).toContain("Could not reach 127.0.0.1:5432");
    expect(h.errors.join("\n")).toContain("pnpm stack:up");
    expect(truncates(h)).toHaveLength(0);
    // Nothing was opened, so there is nothing to close.
    expect(h.closed).toBe(0);
  });

  it("never claims success when seeding fails", async () => {
    const h = harness({ seedError: new Error("seed blew up") });
    expect(await runReset(["--yes", "--seed"], h.deps, LOCAL_ENV)).toBe(1);
    expect(h.errors.join("\n")).toContain("seeding failed");
    expect(output(h)).not.toContain("Reset complete");
  });
});

// ─── Boundary ─────────────────────────────────────────────────────────

describe("local test-data reset (boundary)", () => {
  it("accepts only loopback hosts", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.9.9.9", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["127.0.0.1.evil.example", "supabase.com", "0.0.0.0", "", "localhost.evil"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("trims whitespace and tolerates an absent port", () => {
    const target = resolveResetTarget({ DATABASE_URL: `  ${LOCAL_URL}  ` });
    expect(target.port).toBe(5432);
    expect(target.database).toBe("talos");
  });

  it("accepts an IPv6 loopback target", () => {
    const target = resolveResetTarget({ DATABASE_URL: "postgresql://postgres:pw@[::1]:5432/talos" });
    expect(target.host).toBe("::1");
    expect(target.display).toBe("postgresql://postgres@[::1]:5432/talos");
  });

  it("prefers DATABASE_URL and only falls back to DIRECT_URL when it is unset", () => {
    const preferred = resolveResetTarget({
      DATABASE_URL: LOCAL_URL,
      DIRECT_URL: "postgresql://postgres:pw@db.remote.example:5432/postgres",
    });
    expect(preferred.host).toBe("127.0.0.1");

    const fallback = resolveResetTarget({ DIRECT_URL: LOCAL_URL });
    expect(fallback.host).toBe("127.0.0.1");

    // A remote DIRECT_URL alone is still refused.
    expect(() =>
      resolveResetTarget({ DIRECT_URL: "postgresql://postgres:pw@db.remote.example:5432/postgres" }),
    ).toThrow(/non-local host/);
  });

  it("quotes identifiers and refuses anything that is not a plain identifier", () => {
    expect(quoteIdent("tls_talos")).toBe('"tls_talos"');
    for (const bad of ['tls_talos"; DROP TABLE x', "Tls_Talos", "tls-talos", ""]) {
      expect(() => quoteIdent(bad)).toThrow(/plain lowercase identifier/);
    }
    expect(() => buildTruncateStatement([])).toThrow(/no tables/);
  });

  it("issues a single idempotent TRUNCATE with no DROP/DELETE and no migrations schema", async () => {
    const h = harness();
    await runReset(["--yes"], h.deps, LOCAL_ENV);
    const statement = truncates(h)[0];
    expect(statement).toBe(`TRUNCATE TABLE ${managedTables().map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
    expect(statement).not.toMatch(/\b(DROP|DELETE|ALTER|drizzle)\b/i);
  });

  it("retries transient connection failures and gives up after the bound", async () => {
    const transient = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const sleeps: number[] = [];
    let attempts = 0;

    const value = await withConnectRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw transient;
        return "ok";
      },
      { attempts: 3, baseDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);

    let exhausted = 0;
    await expect(
      withConnectRetry(
        async () => {
          exhausted += 1;
          throw transient;
        },
        { attempts: 2, baseDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(exhausted).toBe(2);
  });

  it("does not retry non-transient failures such as bad credentials", async () => {
    let attempts = 0;
    const authFailure = Object.assign(new Error('password authentication failed for user "postgres"'), {
      code: "28P01",
    });
    await expect(
      withConnectRetry(
        async () => {
          attempts += 1;
          throw authFailure;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("authentication failed");
    expect(attempts).toBe(1);
  });
});

// ─── Regression / privacy ─────────────────────────────────────────────

describe("local test-data reset (privacy regression)", () => {
  it("redacts credentials and query parameters from printed URLs", () => {
    expect(redactDatabaseUrl("postgresql://postgres:sup3rpw@127.0.0.1:5432/talos?sslmode=require")).toBe(
      "postgresql://postgres@127.0.0.1:5432/talos",
    );
    expect(redactDatabaseUrl("")).toBe("(unset)");
    expect(redactDatabaseUrl("::::")).toBe("(unparseable database url)");
  });

  it("scrubs credentials, secret assignments, and key material from error text", () => {
    const scrubbed = redactSecrets(
      "failed postgresql://postgres:hunter2@127.0.0.1:5432/talos password=hunter2 " +
        "seed=" +
        "a".repeat(70),
    );
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).not.toContain("a".repeat(70));
    expect(scrubbed).toContain("[redacted]");
  });

  it("never prints the password on the happy path", async () => {
    const h = harness();
    await runReset(["--yes"], h.deps, { DATABASE_URL: LOCAL_URL.replace("postgres@", "postgres:sup3rpw@") });
    expect(output(h)).not.toContain("sup3rpw");
    expect(output(h)).toContain("postgres@127.0.0.1:5432/talos");
  });

  it("never prints the password when the driver error embeds the connection URL", async () => {
    const h = harness({
      createError: Object.assign(
        new Error("getaddrinfo ENOTFOUND postgresql://postgres:sup3rpw@127.0.0.1:5432/talos"),
        { code: "ENOTFOUND" },
      ),
    });
    expect(await runReset(["--yes"], h.deps, LOCAL_ENV)).toBe(1);
    expect(output(h)).not.toContain("sup3rpw");
    expect(output(h)).toContain("[redacted]");
  });

  it("exposes stable error codes for callers and CI assertions", () => {
    expect(resetErrorCode(() => parseResetArgs(["--nope"]))).toBe("unknown_argument");
    expect(resetErrorCode(() => resolveResetTarget({}))).toBe("missing_database_url");
    expect(resetErrorCode(() => resolveResetTarget({ DATABASE_URL: "postgresql://postgres@10.0.0.5:5432/talos" }))).toBe(
      "non_local_target",
    );
    expect(resetErrorCode(() => buildTruncateStatement([]))).toBe("empty_plan");
    expect(resetErrorCode(() => quoteIdent("bad name"))).toBe("unsafe_table_name");
    expect(resetErrorCode(() => { throw new ResetError("reset_failed", "x"); })).toBe("reset_failed");
    expect(resetErrorCode(() => { throw new Error("plain"); })).toBeUndefined();
  });
});
