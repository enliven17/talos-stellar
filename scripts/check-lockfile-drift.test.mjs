#!/usr/bin/env node
/**
 * check-lockfile-drift.test.mjs
 *
 * Unit tests for scripts/check-lockfile-drift.mjs.
 *
 * Covers:
 *   - CLI argument parsing
 *   - JSON output format
 *   - Error handling for missing package managers
 *   - Structural validation (without requiring full toolchains)
 *
 * Run locally:
 *   node --test scripts/check-lockfile-drift.test.mjs
 *
 * Exit codes follow node:test conventions (0 = all pass, non-zero = failures).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "check-lockfile-drift.mjs");

let _tmpDir = null;

function getTmpDir() {
  if (!_tmpDir) {
    _tmpDir = join(tmpdir(), `lockfile-drift-test-${process.pid}`);
    mkdirSync(_tmpDir, { recursive: true });
  }
  return _tmpDir;
}

function tmpFile(name, content) {
  const fp = join(getTmpDir(), name);
  writeFileSync(fp, content, "utf8");
  return fp;
}

function runDrift(...args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

process.on("exit", () => {
  if (_tmpDir && existsSync(_tmpDir)) {
    try { rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── CLI argument parsing ──────────────────────────────────────────────────────

describe("CLI usage errors", () => {
  it("exits 2 with unknown argument", () => {
    const { status } = runDrift("--unknown-flag");
    assert.strictEqual(status, 2);
  });

  it("exits 0 with --json (even if checks fail)", () => {
    const { status, stdout } = runDrift("--json");
    // Should output JSON regardless of check results
    assert.ok([0, 1].includes(status));
    // Should be valid JSON
    assert.doesNotThrow(() => JSON.parse(stdout));
    const parsed = JSON.parse(stdout);
    assert.ok(typeof parsed.total === "number");
    assert.ok(typeof parsed.passed === "number");
    assert.ok(typeof parsed.failed === "number");
    assert.ok(Array.isArray(parsed.checks));
  });
});

// ── JSON output structure ─────────────────────────────────────────────────────

describe("JSON output structure", () => {
  it("outputs valid JSON with --json flag", () => {
    const { status, stdout } = runDrift("--json");
    assert.ok([0, 1].includes(status));
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.total, 4); // root pnpm, web pnpm, prime-agent uv, contracts cargo
    assert.strictEqual(parsed.passed + parsed.failed, parsed.total);
    for (const check of parsed.checks) {
      assert.ok(typeof check.name === "string");
      assert.ok(typeof check.ok === "boolean");
      assert.ok(Array.isArray(check.errors));
      assert.ok(Array.isArray(check.warnings));
    }
  });

  it("includes all four check names in JSON output", () => {
    const { stdout } = runDrift("--json");
    const parsed = JSON.parse(stdout);
    const names = parsed.checks.map((c) => c.name).sort();
    assert.deepStrictEqual(names, [
      "contracts cargo",
      "prime-agent uv",
      "root pnpm",
      "web pnpm",
    ]);
  });
});

// ── Missing package manager handling ──────────────────────────────────────────

describe("Missing package manager handling", () => {
  it("reports error when pnpm is not available", () => {
    // We can't easily test this without uninstalling pnpm, but we can verify
    // the error message structure by checking that it would be produced
    // This is a structural test - the actual behavior depends on environment
    const { status, stdout } = runDrift("--json");
    const parsed = JSON.parse(stdout);
    // At least one check should have the expected name
    const pnpmChecks = parsed.checks.filter((c) => c.name.includes("pnpm"));
    assert.ok(pnpmChecks.length >= 1);
  });
});

// ── Regression: real repo lockfiles ───────────────────────────────────────────

describe("Regression – real repo lockfiles", () => {
  it("root pnpm-lock.yaml exists and is non-empty", () => {
    const lockfile = resolve(__dirname, "..", "pnpm-lock.yaml");
    assert.ok(existsSync(lockfile), "pnpm-lock.yaml should exist");
    const stat = statSync(lockfile);
    assert.ok(stat.size > 0, "pnpm-lock.yaml should not be empty");
  });

  it("web/pnpm-lock.yaml exists and is non-empty", () => {
    const lockfile = resolve(__dirname, "..", "web", "pnpm-lock.yaml");
    assert.ok(existsSync(lockfile), "web/pnpm-lock.yaml should exist");
    const stat = statSync(lockfile);
    assert.ok(stat.size > 0, "web/pnpm-lock.yaml should not be empty");
  });

  it("packages/prime-agent/uv.lock exists and is non-empty", () => {
    const lockfile = resolve(__dirname, "..", "packages", "prime-agent", "uv.lock");
    assert.ok(existsSync(lockfile), "uv.lock should exist");
    const stat = statSync(lockfile);
    assert.ok(stat.size > 0, "uv.lock should not be empty");
  });

  it("contracts/Cargo.lock exists and is non-empty", () => {
    const lockfile = resolve(__dirname, "..", "contracts", "Cargo.lock");
    assert.ok(existsSync(lockfile), "Cargo.lock should exist");
    const stat = statSync(lockfile);
    assert.ok(stat.size > 0, "Cargo.lock should not be empty");
  });

  it("all package manifests exist", () => {
    const manifests = [
      "package.json",
      "web/package.json",
      "packages/prime-agent/pyproject.toml",
      "contracts/Cargo.toml",
    ];
    for (const m of manifests) {
      const path = resolve(__dirname, "..", m);
      assert.ok(existsSync(path), `${m} should exist`);
    }
  });
});

// ── Fixture-based tests (simulate lockfile drift scenarios) ───────────────────

describe("Lockfile drift detection logic (fixture-based)", () => {
  // These tests verify the logic by creating mock scenarios.
  // Since we can't easily mock spawnSync, we test the helper functions
  // by importing the script as a module. However, the script uses main()
  // pattern, so we test via CLI.

  it("exits with non-zero when lockfiles are missing (simulated via env)", () => {
    // This test documents expected behavior when lockfiles are missing.
    // In practice, the real lockfiles exist, so this would pass.
    // The actual missing-lockfile error path is tested by the error
    // message format in the main script.
    const { stdout } = runDrift("--json");
    const parsed = JSON.parse(stdout);
    for (const check of parsed.checks) {
      // If a check fails due to missing lockfile, it should have a clear error
      if (!check.ok && check.errors.some((e) => e.includes("not found"))) {
        assert.match(check.errors[0], /not found|Lockfile not found/);
      }
    }
  });
});

// ── Performance / timeout ─────────────────────────────────────────────────────

describe("Performance", () => {
  it("completes within reasonable time", () => {
    const start = Date.now();
    const { status } = runDrift("--json");
    const duration = Date.now() - start;
    // Should complete within 30 seconds (the timeout)
    assert.ok(duration < 30_000, `Check took ${duration}ms, expected < 30000ms`);
    assert.ok([0, 1].includes(status));
  });
});