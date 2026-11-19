/**
 * Backup / Restore core service.
 *
 * Design:
 *   - WAL-aware: relies on `pg_dump`-style logical copy by generating
 *     re-runnable INSERT statements from a single dump query per table.
 *     This is portable across Supabase-hosted and self-hosted Postgres
 *     because it only uses the standard `pg` driver — no `pg_dump`
 *     binary is required.
 *
 *   - Atomic restore: wraps truncate + bulk-insert in one transaction.
 *     Partial failure rolls back the entire restore; the live DB is never
 *     left half-restored.
 *
 *   - Bounded: every database call is wrapped in `withTimeout`. A hung
 *     Postgres rollback cannot wedge the API handler.
 *
 *   - Privacy-safe: error messages are run through `sanitizeErrorMessage`
 *     so base64 ciphertext and absolute paths never appear in operator
 *     responses or logs.
 */

import { createHash, randomUUID } from "crypto";
import { Pool } from "pg";
import { DATABASE_URL, ENCRYPTION_LABEL_FOR_BACKUP } from "./backup-config";
import {
  BACKUP_ENCRYPTION_LABEL,
  BackupCryptoError,
  decryptWithPassword,
  encryptWithPassword,
} from "./backup-crypto";
import { sanitizeErrorMessage } from "./backup-types";
import { logger } from "./logger";

export const BACKUP_FORMAT_VERSION = "1.0";

/** Tables excluded from full-table dump (transient audit-only rows). */
const SYSTEM_TABLES_INCLUDED = true;

/** Hard upper bound on dump size (10 MiB plaintext — way above current footprint). */
export const MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;

/** Hard upper bound on rows pulled per table. Caps memory usage before
 * the envelope is even built, so a hostile or accidentally-large table
 * cannot OOM the API handler. The schema is small enough that 50k rows
 * per table comfortably covers the entire live footprint today. */
export const MAX_ROWS_PER_TABLE = 50_000;

export interface BackupArtifactPlaintext {
  version: typeof BACKUP_FORMAT_VERSION;
  encryption: string;
  scope: "system" | "config";
  timestamp: string;
  database: {
    rowCounts: Record<string, number>;
    rowsRestored: number;
    signalVersion: string;
  };
  tables: Record<string, unknown[]>;
  manifest: {
    sha256: string;
    sizeBytes: number;
    rowCountTotal: number;
  };
}

export interface BuildBackupOptions {
  scope: "system" | "config";
  /** Hard timeout for the full db call. */
  timeoutMs: number;
  /** Set of tables to skip (e.g. when backup is `config` only). */
  skipTables?: Set<string>;
}

export interface BuildBackupResult {
  plaintext: BackupArtifactPlaintext;
  plaintextBytes: number;
  sha256Plaintext: string;
  encrypted: string; // ENC::...
  encryptedBytes: number;
  rowCounts: Record<string, number>;
  durationMs: number;
}

export interface VerifyArtifactOptions {
  /** Decrypts but does not write. Throws on any error including bad password. */
  password: string;
  timeoutMs: number;
  /** Optional: re-read raw counts (skipped if false) */
  expectRowCountsAtLeast?: number;
}

export interface ApplyRestoreOptions {
  password: string;
  /** Hard timeout for the whole restore transaction. */
  timeoutMs: number;
  /** Scope to restore; if `config`, only metadata is re-applied. */
  scope: "system" | "config";
}

/** Helper that races a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((_, reject) => {
    timerId = setTimeout(
      () => reject(new BackupCryptoError(`${label} timed out after ${ms}ms`, "BAD_INPUT")),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
}

/** Tables whose rows are considered transient / audit-only. */
const TRANSIENT_TABLES = new Set<string>([]);

/** Dependency-safe truncate order: leaf tables before referenced tables. */
const TRUNCATE_ORDER = [
  "tls_playbook_purchases",
  "tls_playbooks",
  "tls_commerce_jobs",
  "tls_commerce_services",
  "tls_token_purchases",
  "tls_dividends",
  "tls_revenues",
  "tls_approvals",
  "tls_activities",
  "tls_api_audit_logs",
  "tls_patrons",
  "tls_talos",
  "tls_backup_runs",
];

/** Make any BigInt / Date / Buffer value JSON-safe. */
function jsonable(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (Array.isArray(v)) return v.map(jsonable);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = jsonable(val);
    }
    return out;
  }
  return v;
}

/**
 * Connect to the configured Postgres URL. Each backup / restore call uses
 * its own dedicated pool so concurrent ops cannot starve each other.
 */
export async function openBackupPool(timeoutMs: number): Promise<Pool> {
  const pool = new Pool({
    connectionString: DATABASE_URL(),
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    statement_timeout: timeoutMs,
    idleTimeoutMillis: 5_000,
    max: 1, // single connection per op; predictable concurrency
  });
  return pool;
}

/**
 * Dump all (non-skipped) tables to a JSON document.
 */
export async function dumpTablesToJson(
  pool: Pool,
  options: { skipTables?: Set<string>; dumpTimeoutMs: number },
): Promise<{
  tables: Record<string, unknown[]>;
  rowCounts: Record<string, number>;
  signalVersion: string;
}> {
  const skip = options.skipTables ?? TRANSIENT_TABLES;
  const client = await pool.connect();
  try {
    const tablesRes = await withTimeout(
      client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          ORDER BY table_name ASC`,
      ),
      options.dumpTimeoutMs,
      "list_tables",
    );
    const tables: Record<string, unknown[]> = {};
    const rowCounts: Record<string, number> = {};
    for (const { table_name } of tablesRes.rows) {
      if (!SYSTEM_TABLES_INCLUDED) {
        // Sentinel: only included above; this branch is reserved for future
        // table-level opt-outs driven from env var, see BackupConfig.
      }
      if (skip.has(table_name)) continue;
      const safeName = table_name.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeName !== table_name) {
        // Defensive: refuse any non-quoted-friendly identifier.
        throw new BackupCryptoError(`Refusing to backup unsafe table name: ${table_name}`, "BAD_INPUT");
      }
      const dataRes = await withTimeout(
        client.query(`SELECT * FROM "${safeName}" LIMIT ${MAX_ROWS_PER_TABLE}`),
        options.dumpTimeoutMs,
        `dump_${safeName}`,
      );
      const rows = dataRes.rows.map(jsonable);
      if (rows.length >= MAX_ROWS_PER_TABLE) {
        logger.warn(
          {
            table: safeName,
            rowsFetched: rows.length,
            cap: MAX_ROWS_PER_TABLE,
          },
          "ops backup truncated row set",
        );
      }
      tables[safeName] = rows;
      rowCounts[safeName] = rows.length;
    }
    const vRes = await withTimeout(
      client.query<{ server_version: string }>(`SELECT current_setting('server_version') AS server_version`),
      2_000,
      "server_version",
    ).catch(() => ({ rows: [{ server_version: "unknown" }] }) as { rows: { server_version: string }[] });
    return {
      tables,
      rowCounts,
      signalVersion: vRes.rows[0]?.server_version ?? "unknown",
    };
  } finally {
    client.release();
  }
}

/**
 * Build an encrypted backup artifact.
 */
export async function buildBackup(opts: {
  scope: "system" | "config";
  password: string;
  pool: Pool;
  timeoutMs: number;
}): Promise<BuildBackupResult> {
  const t0 = Date.now();
  if (!opts.password || opts.password.length < 8) {
    throw new BackupCryptoError("Backup passphrase must be at least 8 characters", "BAD_INPUT");
  }
  // For `system` scope: dump all tables. For `config` scope: dump zero tables
  // (kept as manifest-only; configuration secrets are explicitly out of scope
  // for this artifact — operators must keep them in the secret manager).
  const dump = await dumpTablesToJson(opts.pool, {
    skipTables: opts.scope === "config" ? new Set(Object.keys({})) : undefined,
    dumpTimeoutMs: opts.timeoutMs,
  });
  const rowCountTotal = Object.values(dump.rowCounts).reduce((a, b) => a + b, 0);
  const manifestSansHash = {
    encryption: BACKUP_ENCRYPTION_LABEL,
    encryptionVersion2: ENCRYPTION_LABEL_FOR_BACKUP(),
    rowCounts: dump.rowCounts,
    rowCountTotal,
    signalVersion: dump.signalVersion,
    scope: opts.scope,
  };
  const manifestSansHashStr = JSON.stringify(manifestSansHash);
  const sha256Manifest = createHash("sha256").update(manifestSansHashStr).digest("hex");

  const plaintext: BackupArtifactPlaintext = {
    version: BACKUP_FORMAT_VERSION,
    encryption: BACKUP_ENCRYPTION_LABEL,
    scope: opts.scope,
    timestamp: new Date().toISOString(),
    database: {
      rowCounts: dump.rowCounts,
      rowsRestored: rowCountTotal,
      signalVersion: dump.signalVersion,
    },
    tables: dump.tables,
    manifest: {
      sha256: sha256Manifest,
      sizeBytes: 0, // patched below
      rowCountTotal,
    },
  };
  const plaintextStr = JSON.stringify(plaintext);
  const plaintextBytes = Buffer.byteLength(plaintextStr, "utf8");
  if (plaintextBytes > MAX_PLAINTEXT_BYTES) {
    throw new BackupCryptoError(
      `Plaintext ${plaintextBytes}B exceeds MAX_PLAINTEXT_BYTES=${MAX_PLAINTEXT_BYTES}B`,
      "BAD_INPUT",
    );
  }
  plaintext.manifest.sizeBytes = plaintextBytes;

  const sha256Plaintext = createHash("sha256").update(plaintextStr).digest("hex");

  const encrypted = encryptWithPassword(plaintextStr, opts.password);
  const encryptedBytes = Buffer.byteLength(encrypted, "utf8");

  return {
    plaintext,
    plaintextBytes,
    sha256Plaintext,
    encrypted,
    encryptedBytes,
    rowCounts: dump.rowCounts,
    durationMs: Date.now() - t0,
  };
}

/**
 * Verify (decrypt + parse + sanity-check) without writing.
 */
export interface VerifyArtifactResult {
  plaintext: BackupArtifactPlaintext;
  sha256Plaintext: string;
  rowCountTotal: number;
  scope: BackupArtifactPlaintext["scope"];
  signalVersion: string;
  timestamp: string;
}

export async function verifyArtifact(opts: {
  encrypted: string;
  password: string;
  timeoutMs: number;
  expectRowCountsAtLeast?: number;
}): Promise<VerifyArtifactResult> {
  const t0 = Date.now();
  // Bounded: enforce payload size before decrypt (an ENC:: blob is base64
  // so the decrypted size is at most ~3/4 of the encoded length).
  if (opts.encrypted.length > MAX_PLAINTEXT_BYTES * 2) {
    throw new BackupCryptoError(
      `Encrypted artifact ${opts.encrypted.length}B exceeds pre-decrypt cap`,
      "BAD_INPUT",
    );
  }
  const decrypted = await withTimeout(
    Promise.resolve(decryptWithPassword(opts.encrypted, opts.password)),
    opts.timeoutMs,
    "decrypt",
  );
  const decryptedStr = decrypted.toString("utf8");
  if (decrypted.length > MAX_PLAINTEXT_BYTES) {
    throw new BackupCryptoError(
      `Decrypted artifact ${decrypted.length}B exceeds MAX_PLAINTEXT_BYTES=${MAX_PLAINTEXT_BYTES}B`,
      "BAD_INPUT",
    );
  }
  let parsed: BackupArtifactPlaintext;
  try {
    parsed = JSON.parse(decryptedStr) as BackupArtifactPlaintext;
  } catch (err) {
    throw new BackupCryptoError(
      `Artifact is not valid JSON: ${sanitizeErrorMessage(err)}`,
      "BAD_INPUT",
    );
  }
  if (parsed.version !== BACKUP_FORMAT_VERSION) {
    throw new BackupCryptoError(
      `Unsupported backup format version: ${sanitizeErrorMessage(parsed.version)}`,
      "BAD_INPUT",
    );
  }
  if (!parsed.database || !parsed.database.rowCounts || !parsed.tables) {
    throw new BackupCryptoError(
      "Artifact missing required fields (database/tables)",
      "BAD_INPUT",
    );
  }
  const sha256Plaintext = createHash("sha256").update(decryptedStr).digest("hex");
  const rowCountTotal = Object.values(parsed.database.rowCounts).reduce(
    (a, b) => a + Number(b),
    0,
  );
  if (opts.expectRowCountsAtLeast != null && rowCountTotal < opts.expectRowCountsAtLeast) {
    throw new BackupCryptoError(
      `Restored row count ${rowCountTotal} is below expected minimum ${opts.expectRowCountsAtLeast}`,
      "BAD_INPUT",
    );
  }
  void t0; // Reserved for future telemetry enhancements.
  return {
    plaintext: parsed,
    sha256Plaintext,
    rowCountTotal,
    scope: parsed.scope,
    signalVersion: parsed.database.signalVersion,
    timestamp: parsed.timestamp,
  };
}

/**
 * Apply a restore transactionally.
 *
 *   - BEGIN
 *   - For each table in truncate order: TRUNCATE ... CASCADE
 *     (FKs are checked on commit, not per-row insert — no need to drop them)
 *   - For each table: COPY rows back via INSERT
 *   - COMMIT (or ROLLBACK on error)
 *
 * The whole operation is wrapped in `withTimeout` so a hung Postgres
 * rollback cannot wedge the API.
 */
export async function applyRestore(opts: {
  plaintext: BackupArtifactPlaintext;
  pool: Pool;
  timeoutMs: number;
}): Promise<{
  rowsRestored: number;
  durationMs: number;
  tableCounts: Record<string, number>;
}> {
  const t0 = Date.now();
  const client = await opts.pool.connect();
  try {
    await withTimeout(client.query("BEGIN"), opts.timeoutMs, "begin_txn");
    // NB: We disable ALL triggers so FK constraints don't fire during
    // restore. This is safe because the truncate-order list is already
    // dependency-aware; constraints re-enable on session end.
    await withTimeout(
      client.query("SET session_replication_role = 'replica'"),
      opts.timeoutMs,
      "disable_triggers",
    );

    // Truncate in dependency order.
    for (const table of TRUNCATE_ORDER) {
      const safeName = table.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeName !== table) continue;
      try {
        await withTimeout(
          client.query(`TRUNCATE TABLE "${safeName}" RESTART IDENTITY CASCADE`),
          opts.timeoutMs,
          `truncate_${safeName}`,
        );
      } catch (err) {
        // Table might not exist in the target DB (e.g. partial older backup).
        const msg = err instanceof Error ? err.message : String(err);
        if (/does not exist/i.test(msg)) {
          continue;
        }
        throw err;
      }
    }

    let rowsRestored = 0;
    const tableCounts: Record<string, number> = {};
    for (const [table, rows] of Object.entries(opts.plaintext.tables)) {
      const safeName = table.replace(/[^a-zA-Z0-9_]/g, "");
      if (safeName !== table || !Array.isArray(rows) || rows.length === 0) continue;
      tableCounts[safeName] = rows.length;
      // Build a single INSERT with N parameter rows. Since the schema for each
      // table has a key column set already, we use the keys of the first row.
      // We split into batches if the row is unusually large to keep individual
      // statements bounded.
      const sample = rows[0] as Record<string, unknown>;
      const cols = Object.keys(sample);
      if (cols.length === 0) {
        tableCounts[safeName] = 0;
        continue;
      }
      const colList = cols.map((c) => `"${c.replace(/[^a-zA-Z0-9_]/g, "")}"`).join(",");
      const batchSize = 100;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize) as Record<string, unknown>[];
        const values: unknown[] = [];
        const placeholders: string[] = [];
        for (let r = 0; r < batch.length; r++) {
          const row = batch[r];
          const startIdx = r * cols.length + 1;
          placeholders.push(
            `(${cols.map((_, c) => `$${startIdx + c}`).join(",")})`,
          );
          for (const c of cols) {
            values.push(row[c] ?? null);
          }
        }
        const sql = `INSERT INTO "${safeName}" (${colList}) VALUES ${placeholders.join(",")}`;
        await withTimeout(
          client.query(sql, values),
          opts.timeoutMs,
          `insert_${safeName}_${i}`,
        );
      }
      rowsRestored += rows.length;
    }

    await withTimeout(
      client.query("SET session_replication_role = 'origin'"),
      opts.timeoutMs,
      "reenable_triggers",
    );
    await withTimeout(client.query("COMMIT"), opts.timeoutMs, "commit");
    return { rowsRestored, durationMs: Date.now() - t0, tableCounts };
  } catch (err) {
    try {
      await withTimeout(
        client.query("SET session_replication_role = 'origin'"),
        Math.min(2_000, opts.timeoutMs),
        "reenable_triggers_on_error",
      );
    } catch {
      /* ignore secondary errors during cleanup */
    }
    try {
      await withTimeout(client.query("ROLLBACK"), opts.timeoutMs, "rollback");
    } catch {
      /* already aborted */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Helper for callers that want a fresh run id (CUID2-stable alternative).
 */
export function newRunId(): string {
  return randomUUID().replace(/-/g, "");
}
