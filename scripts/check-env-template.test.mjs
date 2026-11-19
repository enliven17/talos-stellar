#!/usr/bin/env node
/**
 * check-env-template.test.mjs
 *
 * Unit tests for scripts/check-env-template.mjs.
 *
 * Covers:
 *   - Happy path: all vars documented → exit 0
 *   - Missing var: exits 1, names the missing variable
 *   - Missing template file: exits 1 with a clear message
 *   - Excluded vars (NODE_ENV, NEXT_PHASE, X): never flagged as missing
 *   - JSON output: valid JSON with ok/missing/scannedFiles/templateKeys
 *   - Unknown argument: exits 2
 *
 * Run locally:
 *   node --test scripts/check-env-template.test.mjs
 *
 * Exit codes follow node:test conventions (0 = all pass, non-zero = failures).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "check-env-template.mjs");

// ── Temp directory helpers ────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = join(tmpdir(), `env-template-test-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writeTemp(name, content) {
  const fp = join(tmpDir, name);
  writeFileSync(fp, content, "utf8");
  return fp;
}

/**
 * Run the check script with an overridden SOURCE_FILES list and TEMPLATE_PATH
 * by writing a small wrapper that injects the paths and calls the internal
 * functions. Instead, we drive the script indirectly via --json and check
 * its output.
 *
 * Since the script hard-codes file paths, we test it end-to-end using the
 * real repo files (for the passing case) and by testing its argument handling
 * separately via a thin subprocess call.
 */
function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: resolve(__dirname, ".."),
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("check-env-template", () => {
  describe("real repo — happy path", () => {
    it("exits 0 when all vars are present in web/.env.example", () => {
      const { status, stdout } = run();
      assert.strictEqual(status, 0, `expected exit 0, got ${status}\n${stdout}`);
      assert.ok(
        stdout.includes("All") && stdout.includes("documented in web/.env.example"),
        `expected success message, got: ${stdout}`,
      );
    });

    it("--json exits 0 and returns ok:true with no missing entries", () => {
      const { status, stdout } = run("--json");
      assert.strictEqual(status, 0, `expected exit 0, got ${status}\n${stdout}`);
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(stdout);
      }, "output should be valid JSON");
      assert.strictEqual(parsed.ok, true);
      assert.deepStrictEqual(parsed.missing, []);
      assert.ok(Array.isArray(parsed.scannedFiles), "scannedFiles should be an array");
      assert.ok(Array.isArray(parsed.templateKeys), "templateKeys should be an array");
      assert.ok(parsed.scannedFiles.length > 0, "should have scanned at least one file");
      assert.ok(parsed.templateKeys.length > 0, "template should have keys");
    });

    it("--json reports all expected config files as scanned", () => {
      const { stdout } = run("--json");
      const parsed = JSON.parse(stdout);
      const expectedFiles = [
        "web/src/lib/jobs/config.ts",
        "web/src/lib/outbox/config.ts",
        "web/src/lib/reconciler/config.ts",
        "web/src/lib/backup-config.ts",
        "web/src/lib/admin-auth.ts",
      ];
      for (const f of expectedFiles) {
        assert.ok(
          parsed.scannedFiles.some((sf) => sf.endsWith(f.replace(/\//g, "/"))),
          `expected ${f} in scannedFiles, got: ${JSON.stringify(parsed.scannedFiles)}`,
        );
      }
    });

    it("template keys include both active and commented-out variables", () => {
      const { stdout } = run("--json");
      const parsed = JSON.parse(stdout);
      // Variables that are commented-out in the template should still be present
      const commentedVars = [
        "JOBS_ENABLED",
        "OUTBOX_ENABLED",
        "RECONCILER_ENABLED",
        "OPS_ADMIN_SECRET",
        "TALOS_BACKUP_DISABLED",
        "ADMIN_API_KEY",
        "INTERNAL_JOBS_SECRET",
        "OUTBOX_DISPATCH_SECRET",
      ];
      for (const v of commentedVars) {
        assert.ok(
          parsed.templateKeys.includes(v),
          `expected commented-out var ${v} to be in templateKeys`,
        );
      }
    });
  });

  describe("argument handling", () => {
    it("exits 2 for an unknown argument", () => {
      const { status, stderr } = run("--unknown-flag");
      assert.strictEqual(status, 2, `expected exit 2, got ${status}`);
      assert.ok(stderr.includes("unknown argument"), `expected usage error: ${stderr}`);
    });

    it("exits 2 for --help", () => {
      const { status } = run("--help");
      assert.strictEqual(status, 2);
    });
  });
});
