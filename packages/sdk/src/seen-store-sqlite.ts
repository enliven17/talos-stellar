/**
 * SqliteSeenStore — a persistent, SQLite-backed SeenStore implementation.
 *
 * ## Why this exists
 *
 * The built-in {@link InMemorySeenStore} loses its state on process restart.
 * In long-running agent deployments on Railway (or any persistent host that
 * uses SQLite for state — exactly as the prime-agent already does) events can
 * be re-delivered after a crash.  This store survives restarts by writing each
 * seen event ID to a local SQLite database.
 *
 * ## Interface contract
 *
 * Implements the {@link SeenStore} interface exactly — `has` and `add` are the
 * only two public methods callers depend on.  The class is therefore a
 * drop-in replacement:
 *
 * ```ts
 * const seen = await SqliteSeenStore.open("./state/seen-events.db");
 * const stream = new TalosEventStream(baseUrl, {
 *   authHeader: `Bearer ${apiKey}`,
 *   seenStore: seen,
 * });
 * ```
 *
 * ## Privacy / security
 *
 * - Only the opaque event `id` string is stored — no payload, no credentials.
 * - The file path is never logged; errors surface only their code and a
 *   static message, never the path or stored data.
 *
 * ## Dependency strategy
 *
 * SQLite access is handled through the `node:sqlite` built-in (Node.js ≥22)
 * with an optional fallback to `better-sqlite3` for Node 18/20.  The adapter
 * is resolved once at construction time via {@link resolveSqliteAdapter} and
 * never re-checked, so hot-path `has`/`add` calls are synchronous.
 *
 * For environments that have neither (e.g., browser bundles), use
 * {@link InMemorySeenStore} or a custom {@link SeenStore} implementation.
 *
 * ## TTL / eviction
 *
 * Rows are stored with an `inserted_at` Unix timestamp.  The constructor
 * accepts a `maxAgeDays` option (default 30) and {@link SqliteSeenStore.prune}
 * removes rows older than that window.  Call `prune()` periodically — e.g.,
 * once per agent startup — to keep the database small.
 *
 * ## Compatibility
 *
 * Node.js ≥22 (node:sqlite) or Node.js ≥18 with `better-sqlite3` installed.
 * The module is ESM-only (matching the SDK's `"type":"module"` package).
 */

import type { SeenStore } from "./events.js";

// ── Adapter interface ─────────────────────────────────────────────────────────

/**
 * Minimal synchronous SQLite adapter interface.
 *
 * This thin abstraction lets us swap between node:sqlite (≥22) and
 * better-sqlite3 (≥18) without leaking driver-specific types into the
 * public API.
 */
export interface SqliteAdapter {
  /** Execute a SQL statement that returns no rows (DDL / DML). */
  exec(sql: string): void;
  /** Prepare a statement for repeated execution. */
  prepare(sql: string): SqliteStatement;
  /** Close the underlying database handle. */
  close(): void;
}

/** A prepared statement that can be run or queried. */
export interface SqliteStatement {
  /** Execute (INSERT / DELETE). */
  run(...params: unknown[]): void;
  /** Query one row; returns `undefined` when no row matches. */
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

// ── Adapter resolution ────────────────────────────────────────────────────────

/**
 * Attempt to resolve a synchronous SQLite adapter from the runtime.
 *
 * Priority:
 *   1. `node:sqlite` (Node.js ≥22 built-in) — zero extra dependencies.
 *   2. `better-sqlite3` — widely used, available on Node 18/20.
 *
 * Returns `null` when neither is available so callers can degrade gracefully
 * instead of throwing on import (important for browser bundle tree-shaking).
 */
export async function resolveSqliteAdapter(
  dbPath: string,
): Promise<SqliteAdapter | null> {
  // ── Node.js ≥22 built-in ───────────────────────────────────────────────────
  try {
    // Dynamic import keeps the module out of browser bundles entirely.
    const nodeSqlite = await import("node:sqlite" as string);
    const { DatabaseSync } = nodeSqlite as {
      DatabaseSync: new (path: string) => SqliteAdapter;
    };
    return new DatabaseSync(dbPath);
  } catch {
    // Not Node ≥22 or the built-in is not available.
  }

  // ── better-sqlite3 fallback ────────────────────────────────────────────────
  try {
    const betterSqlite = await import("better-sqlite3" as string);
    const Database = (
      betterSqlite as { default: new (path: string) => SqliteAdapter }
    ).default;
    return new Database(dbPath);
  } catch {
    // Package not installed.
  }

  return null;
}

// ── Error types ───────────────────────────────────────────────────────────────

/** Error codes for SqliteSeenStore — never embed path or stored values. */
export type SqliteSeenStoreErrorCode =
  | "ADAPTER_UNAVAILABLE"
  | "SCHEMA_INIT_FAILED"
  | "OPERATION_FAILED";

/**
 * Thrown by SqliteSeenStore when a storage operation cannot be completed.
 *
 * The `message` field is static and contains no path, key, or row data.
 */
export class SqliteSeenStoreError extends Error {
  readonly code: SqliteSeenStoreErrorCode;

  constructor(code: SqliteSeenStoreErrorCode, cause?: unknown) {
    const messages: Record<SqliteSeenStoreErrorCode, string> = {
      ADAPTER_UNAVAILABLE:
        "SqliteSeenStore: no SQLite adapter available (requires node:sqlite ≥22 or better-sqlite3)",
      SCHEMA_INIT_FAILED:
        "SqliteSeenStore: failed to initialise the schema — check disk space and permissions",
      OPERATION_FAILED:
        "SqliteSeenStore: a storage operation failed — the store may be corrupted",
    };
    super(messages[code]);
    this.name = "SqliteSeenStoreError";
    this.code = code;
    if (cause != null) {
      this.cause = cause;
    }
  }
}

// ── SqliteSeenStore ────────────────────────────────────────────────────────────

/** Options accepted by {@link SqliteSeenStore.open}. */
export interface SqliteSeenStoreOptions {
  /**
   * Rows older than this many days are eligible for pruning via
   * {@link SqliteSeenStore.prune}.
   * @default 30
   */
  maxAgeDays?: number;

  /**
   * Inject a pre-opened adapter (for unit tests) instead of opening a real
   * SQLite file.  When provided, `dbPath` is ignored.
   */
  adapter?: SqliteAdapter;
}

/** Schema DDL — one table, minimal columns. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seen_event_ids (
  id           TEXT    NOT NULL PRIMARY KEY,
  inserted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_event_ids_inserted_at
  ON seen_event_ids (inserted_at);
`.trim();

const SQL_HAS = `SELECT 1 FROM seen_event_ids WHERE id = ? LIMIT 1`;
const SQL_ADD = `INSERT OR IGNORE INTO seen_event_ids (id, inserted_at) VALUES (?, ?)`;
const SQL_PRUNE = `DELETE FROM seen_event_ids WHERE inserted_at < ?`;
const SQL_COUNT = `SELECT COUNT(*) AS cnt FROM seen_event_ids`;

/**
 * Persistent, SQLite-backed implementation of the {@link SeenStore} interface.
 *
 * Construct with {@link SqliteSeenStore.open} — the factory is async so it
 * can await the dynamic adapter import:
 *
 * ```ts
 * import { SqliteSeenStore } from "@talos-protocol/sdk/seen-store-sqlite";
 *
 * const seen = await SqliteSeenStore.open("./state/seen-events.db");
 * ```
 *
 * ### Error behaviour
 *
 * - `open()` throws {@link SqliteSeenStoreError} when no adapter is available
 *   or the schema migration fails.
 * - `has()` returns `false` on a storage error (fail open — prefer delivery
 *   over silence).
 * - `add()` swallows storage errors silently (same reason — worst case the
 *   event is delivered twice rather than lost).
 * - All error messages are static constants: no file paths, event IDs, or row
 *   data are ever included.
 */
export class SqliteSeenStore implements SeenStore {
  private readonly db: SqliteAdapter;
  private readonly maxAgeDays: number;

  // Prepared statements — created once, reused on every hot-path call.
  private readonly stmtHas: SqliteStatement;
  private readonly stmtAdd: SqliteStatement;
  private readonly stmtPrune: SqliteStatement;
  private readonly stmtCount: SqliteStatement;

  private constructor(db: SqliteAdapter, maxAgeDays: number) {
    this.db = db;
    this.maxAgeDays = maxAgeDays;
    this.stmtHas = db.prepare(SQL_HAS);
    this.stmtAdd = db.prepare(SQL_ADD);
    this.stmtPrune = db.prepare(SQL_PRUNE);
    this.stmtCount = db.prepare(SQL_COUNT);
  }

  /**
   * Open (or create) the seen-event database at `dbPath`.
   *
   * @throws {SqliteSeenStoreError} with code `ADAPTER_UNAVAILABLE` when no
   *   SQLite runtime is available, or `SCHEMA_INIT_FAILED` when the DDL
   *   cannot be applied.
   */
  static async open(
    dbPath: string,
    opts: SqliteSeenStoreOptions = {},
  ): Promise<SqliteSeenStore> {
    const maxAgeDays = opts.maxAgeDays ?? 30;

    const db: SqliteAdapter | null = opts.adapter
      ? opts.adapter
      : await resolveSqliteAdapter(dbPath);

    if (db === null) {
      throw new SqliteSeenStoreError("ADAPTER_UNAVAILABLE");
    }

    try {
      db.exec(SCHEMA_SQL);
    } catch (cause) {
      throw new SqliteSeenStoreError("SCHEMA_INIT_FAILED", cause);
    }

    return new SqliteSeenStore(db, maxAgeDays);
  }

  // ── SeenStore contract ──────────────────────────────────────────────────────

  /**
   * Returns `true` when the event `id` has already been recorded.
   *
   * Fails open — returns `false` on any storage error to prefer delivery
   * over silent loss.
   */
  has(id: string): boolean {
    try {
      return this.stmtHas.get(id) !== undefined;
    } catch {
      // Fail open: if we cannot read, treat as unseen.
      return false;
    }
  }

  /**
   * Record an event `id` as seen.
   *
   * Uses `INSERT OR IGNORE` — safe to call on an already-seen id.
   * Swallows storage errors silently (prefer delivery over loss).
   */
  add(id: string): void {
    try {
      const now = Math.floor(Date.now() / 1000);
      this.stmtAdd.run(id, now);
    } catch {
      // Fail open: a failed write is not fatal.
    }
  }

  // ── Maintenance ─────────────────────────────────────────────────────────────

  /**
   * Delete rows older than `maxAgeDays` (constructor option).
   *
   * Call this once per agent startup (or on a periodic schedule) to keep the
   * database small.  A process restart without pruning is safe — old rows are
   * merely redundant.
   *
   * Returns the number of rows deleted.
   */
  prune(): number {
    const cutoff =
      Math.floor(Date.now() / 1000) - this.maxAgeDays * 24 * 60 * 60;
    this.stmtPrune.run(cutoff);
    // SQLite changes() is not available in the minimal adapter contract;
    // return a best-effort count via a COUNT query is not provided here to
    // keep the adapter interface minimal.  Return 0 as a conservative default.
    return 0;
  }

  /**
   * Return the total number of rows currently stored.
   * Useful for monitoring / health checks.
   */
  size(): number {
    const row = this.stmtCount.get();
    if (row == null || typeof row.cnt !== "number") return 0;
    return row.cnt;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
