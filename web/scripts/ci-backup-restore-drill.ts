/**
 * CI backup → verify → restore drill driver.
 *
 * Uses the committed fixtures under web/tests/fixtures/backup-restore/ and the
 * production backup-service APIs (buildBackup / verifyArtifact / applyRestore).
 *
 * Env:
 *   DATABASE_URL          source Postgres (already migrated + seeded)
 *   TARGET_DATABASE_URL   restore target Postgres (already migrated, empty-ish)
 *   BACKUP_PASSPHRASE     ≥ 8 chars
 *   TALOS_BACKUP_TIMEOUT_MS (optional, default 15000)
 *
 * Local (after stack is up + migrated):
 *   pnpm --dir web exec tsx scripts/ci-backup-restore-drill.ts
 *
 * Fail-closed: missing env, empty passphrase, verify mismatch, or restore
 * row-count drift exits non-zero with a privacy-safe message.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Pool } from "pg";
import {
  applyRestore,
  buildBackup,
  openBackupPool,
  verifyArtifact,
} from "../src/lib/backup-service";
import { sanitizeErrorMessage } from "../src/lib/backup-types";

const FIXTURE_DIR = path.join(__dirname, "..", "tests", "fixtures", "backup-restore");

function fail(msg: string, code = 1): never {
  console.error(`BACKUP_RESTORE_DRILL_FAIL: ${msg}`);
  process.exit(code);
}

function loadManifest(): {
  expectedSeedRows: Record<string, number>;
  minTotalRowsAfterSeed: number;
  fixtureTalosName: string;
} {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("manifest.json is malformed JSON");
  }
  if (!parsed || typeof parsed !== "object") fail("manifest.json must be an object");
  const m = parsed as Record<string, unknown>;
  if (!m.expectedSeedRows || typeof m.expectedSeedRows !== "object") {
    fail("manifest.json missing expectedSeedRows");
  }
  if (typeof m.minTotalRowsAfterSeed !== "number") {
    fail("manifest.json missing minTotalRowsAfterSeed");
  }
  if (typeof m.fixtureTalosName !== "string" || !m.fixtureTalosName) {
    fail("manifest.json missing fixtureTalosName");
  }
  return m as {
    expectedSeedRows: Record<string, number>;
    minTotalRowsAfterSeed: number;
    fixtureTalosName: string;
  };
}

async function countRows(pool: Pool, table: string): Promise<number> {
  const safe = table.replace(/[^a-zA-Z0-9_]/g, "");
  if (safe !== table) fail(`refusing unsafe table name: ${table}`);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM "${safe}"`);
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL ?? "";
  const targetUrl = process.env.TARGET_DATABASE_URL ?? "";
  const passphrase = process.env.BACKUP_PASSPHRASE ?? "";
  const timeoutMs = Number(process.env.TALOS_BACKUP_TIMEOUT_MS ?? 15_000);

  if (!sourceUrl) fail("DATABASE_URL is required");
  if (!targetUrl) fail("TARGET_DATABASE_URL is required");
  if (passphrase.length < 8) fail("BACKUP_PASSPHRASE must be ≥ 8 characters");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) fail("TALOS_BACKUP_TIMEOUT_MS invalid");

  const manifest = loadManifest();

  // Confirm fixture seed is present on source before backup.
  const sourceCheck = new Pool({ connectionString: sourceUrl, max: 1 });
  try {
    for (const [table, expected] of Object.entries(manifest.expectedSeedRows)) {
      const n = await countRows(sourceCheck, table);
      if (n < expected) {
        fail(`source ${table} has ${n} rows; expected ≥ ${expected} (seed fixture missing?)`);
      }
    }
  } finally {
    await sourceCheck.end().catch(() => undefined);
  }

  const sourcePool = await openBackupPool(timeoutMs);
  let encrypted = "";
  let sha256Plaintext = "";
  let rowCounts: Record<string, number> = {};
  try {
    const built = await buildBackup({
      scope: "system",
      password: passphrase,
      pool: sourcePool,
      timeoutMs,
    });
    encrypted = built.encrypted;
    sha256Plaintext = built.sha256Plaintext;
    rowCounts = built.rowCounts;
    const total = Object.values(rowCounts).reduce((a, b) => a + b, 0);
    if (total < manifest.minTotalRowsAfterSeed) {
      fail(`backup rowCountTotal=${total} below fixture minimum ${manifest.minTotalRowsAfterSeed}`);
    }
    if (!encrypted.startsWith("ENC::")) fail("buildBackup did not return ENC:: artifact");
    console.log(
      JSON.stringify({
        step: "backup",
        ok: true,
        encryptedBytes: built.encryptedBytes,
        plaintextBytes: built.plaintextBytes,
        sha256Plaintext,
        rowCountTotal: total,
        durationMs: built.durationMs,
      }),
    );
  } finally {
    await sourcePool.end().catch(() => undefined);
  }

  // Verify-only path (no writes).
  const verified = await verifyArtifact({
    encrypted,
    password: passphrase,
    timeoutMs,
    expectRowCountsAtLeast: manifest.minTotalRowsAfterSeed,
  });
  if (verified.sha256Plaintext !== sha256Plaintext) {
    fail("verifyArtifact sha256 mismatch vs buildBackup");
  }
  const talosRows = verified.plaintext.tables["tls_talos"] as Array<Record<string, unknown>> | undefined;
  const name = talosRows?.[0]?.name;
  if (name !== manifest.fixtureTalosName) {
    fail(`fixture talos name mismatch: got ${String(name)}`);
  }
  console.log(
    JSON.stringify({
      step: "verify",
      ok: true,
      sha256Plaintext: verified.sha256Plaintext,
      rowCountTotal: verified.rowCountTotal,
      scope: verified.scope,
    }),
  );

  // Wrong-password must fail closed (negative coverage in CI path).
  let wrongPwFailed = false;
  try {
    await verifyArtifact({ encrypted, password: "definitely-wrong-passphrase", timeoutMs });
  } catch {
    wrongPwFailed = true;
  }
  if (!wrongPwFailed) fail("verifyArtifact accepted wrong passphrase");

  // Apply restore onto target DB.
  const targetPool = new Pool({
    connectionString: targetUrl,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    max: 1,
  });
  try {
    const restored = await applyRestore({
      plaintext: verified.plaintext,
      pool: targetPool,
      timeoutMs,
    });
    for (const [table, expected] of Object.entries(manifest.expectedSeedRows)) {
      const n = await countRows(targetPool, table);
      if (n < expected) {
        fail(`restored ${table} has ${n} rows; expected ≥ ${expected}`);
      }
    }
    // Content check on restored talos row.
    const r = await targetPool.query(
      `SELECT name FROM tls_talos WHERE id = $1`,
      ["dr-test-1"],
    );
    if (r.rows[0]?.name !== manifest.fixtureTalosName) {
      fail("restored tls_talos.name mismatch");
    }
    // Integrity: re-hash plaintext and compare.
    const pt = JSON.stringify(verified.plaintext);
    const rehash = createHash("sha256").update(pt).digest("hex");
    if (rehash !== sha256Plaintext) {
      fail("plaintext re-hash drifted after verify");
    }
    console.log(
      JSON.stringify({
        step: "restore",
        ok: true,
        rowsRestored: restored.rowsRestored,
        durationMs: restored.durationMs,
        tableCounts: restored.tableCounts,
      }),
    );
  } finally {
    await targetPool.end().catch(() => undefined);
  }

  // Persist artifact for upload-artifact step (no secrets in filename).
  const outDir = path.join(__dirname, "..", "..", "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, "fixture-backup.enc");
  fs.writeFileSync(artifactPath, encrypted, "utf8");
  fs.writeFileSync(
    path.join(outDir, "fixture-backup-meta.json"),
    JSON.stringify(
      {
        sha256Plaintext,
        rowCounts,
        encryptedBytes: Buffer.byteLength(encrypted, "utf8"),
        encryption: "AES-256-GCM#PBKDF2-SHA256#200000",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log("BACKUP_RESTORE_DRILL_OK");
}

main().catch((err) => {
  fail(sanitizeErrorMessage(err));
});
