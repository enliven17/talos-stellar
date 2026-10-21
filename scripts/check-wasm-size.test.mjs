/**
 * check-wasm-size.test.mjs
 *
 * Unit tests for scripts/check-wasm-size.mjs.
 * Follows the node:test + assert/strict pattern used across this repo's scripts.
 *
 * Run with:
 *   node --test scripts/check-wasm-size.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "check-wasm-size.mjs");

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Create a temporary directory containing synthetic .wasm files.
 *
 * @param {Record<string, number>} files  name → size in bytes
 * @returns {string} path to the temp dir
 */
function makeTempWasmDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "wasm-test-"));
  for (const [name, size] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.wasm`), Buffer.alloc(size));
  }
  return dir;
}

/**
 * Write a temporary budgets JSON file.
 *
 * @param {Record<string, number | string>} budgets
 * @returns {string} path to the file
 */
function makeTempBudgets(budgets) {
  const dir = mkdtempSync(join(tmpdir(), "budgets-test-"));
  const file = join(dir, "budgets.json");
  writeFileSync(file, JSON.stringify(budgets));
  return file;
}

/**
 * Run the check-wasm-size.mjs script with the given options.
 *
 * @param {{ wasmDir: string, budgetsFile: string }} opts
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function runScript({ wasmDir, budgetsFile }) {
  const args = [
    SCRIPT,
    "--wasm-dir", wasmDir,
    "--budgets", budgetsFile,
  ];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test("all contracts within budget — exits 0 and prints OK", () => {
  const wasmDir = makeTempWasmDir({
    talos_registry: 100_000,
    talos_name_service: 80_000,
  });
  const budgetsFile = makeTempBudgets({
    talos_registry: 200_000,
    talos_name_service: 200_000,
  });

  const { exitCode, stdout } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 0, "should exit 0 when all contracts are within budget");
  assert.match(stdout, /✓ OK/, "should print OK for each passing contract");
  assert.match(stdout, /All contracts within budget/, "should print summary");
});

test("contract exceeds budget — exits 1 and prints OVER", () => {
  const wasmDir = makeTempWasmDir({ talos_registry: 300_000 });
  const budgetsFile = makeTempBudgets({ talos_registry: 200_000 });

  const { exitCode, stdout, stderr } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 1, "should exit 1 when a contract exceeds its budget");
  assert.match(stdout, /✗ OVER/, "should flag the contract as OVER");
  assert.match(stderr, /exceed their WASM size budget/, "should print failure message");
});

test("contract exactly at budget — exits 0", () => {
  const size = 150_000;
  const wasmDir = makeTempWasmDir({ ttl_manager: size });
  const budgetsFile = makeTempBudgets({ ttl_manager: size });

  const { exitCode } = runScript({ wasmDir, budgetsFile });
  assert.equal(exitCode, 0, "contract at exactly the budget limit should pass");
});

test("multiple contracts — only over-budget ones fail", () => {
  const wasmDir = makeTempWasmDir({
    talos_registry: 100_000,   // within budget
    talos_governance: 250_000, // over budget
  });
  const budgetsFile = makeTempBudgets({
    talos_registry: 200_000,
    talos_governance: 200_000,
  });

  const { exitCode, stdout } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 1, "should fail when any contract exceeds budget");
  assert.match(stdout, /✓ OK/, "passing contract should be marked OK");
  assert.match(stdout, /✗ OVER/, "failing contract should be marked OVER");
});

test("wasm file with no budget entry — printed as SKIP, does not fail", () => {
  const wasmDir = makeTempWasmDir({ unknown_contract: 50_000 });
  const budgetsFile = makeTempBudgets({ talos_registry: 200_000 });

  const { exitCode, stdout } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 0, "should not fail for unknown contracts");
  assert.match(stdout, /SKIP/, "unknown contract should be marked SKIP");
});

test("missing wasm dir — exits 0 with no rows (graceful when no build output)", () => {
  const wasmDir = "/nonexistent/path/to/wasm";
  const budgetsFile = makeTempBudgets({ talos_registry: 200_000 });

  const { exitCode } = runScript({ wasmDir, budgetsFile });
  assert.equal(exitCode, 0, "missing wasm dir should not fail (no build output)");
});

test("malformed budgets JSON — exits 1 with an error message", () => {
  const wasmDir = makeTempWasmDir({ talos_registry: 100_000 });
  const dir = mkdtempSync(join(tmpdir(), "budgets-bad-"));
  const budgetsFile = join(dir, "bad.json");
  writeFileSync(budgetsFile, "not valid json {{");

  const { exitCode, stderr } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 1, "malformed JSON should cause exit 1");
  assert.match(stderr, /Failed to load budgets/, "should print informative error");
});

test("comment keys starting with _ are ignored in budgets", () => {
  const wasmDir = makeTempWasmDir({ talos_registry: 100_000 });
  const budgetsFile = makeTempBudgets({
    _comment: "This is a documentation key",
    _how_to_raise: "Raise the value below",
    talos_registry: 200_000,
  });

  const { exitCode, stdout } = runScript({ wasmDir, budgetsFile });

  assert.equal(exitCode, 0, "comment keys must not affect the check");
  assert.doesNotMatch(stdout, /_comment/, "comment keys must not appear in output");
});

test("size table headers are printed", () => {
  const wasmDir = makeTempWasmDir({ talos_registry: 50_000 });
  const budgetsFile = makeTempBudgets({ talos_registry: 200_000 });

  const { stdout } = runScript({ wasmDir, budgetsFile });

  assert.match(stdout, /Contract/, "should print Contract column header");
  assert.match(stdout, /Budget/, "should print Budget column header");
  assert.match(stdout, /Status/, "should print Status column header");
});
