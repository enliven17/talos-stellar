#!/usr/bin/env node
/**
 * check-wasm-size.mjs
 *
 * Reads per-contract WASM size budgets from scripts/wasm-size-budgets.json and
 * compares them against the compiled binaries in
 * contracts/target/wasm32-unknown-unknown/release/*.wasm.
 *
 * Usage (from repo root):
 *   node scripts/check-wasm-size.mjs
 *   node scripts/check-wasm-size.mjs --wasm-dir path/to/release --budgets path/to/budgets.json
 *
 * Exit codes:
 *   0 — all contracts within budget
 *   1 — one or more contracts exceed their budget (or a fatal error occurred)
 *
 * How to raise a budget:
 *   1. Confirm the growth is intentional (new feature, dependency upgrade, etc.)
 *   2. Increase the relevant value in scripts/wasm-size-budgets.json.
 *   3. Document the reason in your PR description so reviewers can verify the change.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Resolve paths ────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { wasmDir: null, budgetsFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wasm-dir" && argv[i + 1]) {
      args.wasmDir = argv[++i];
    } else if (argv[i] === "--budgets" && argv[i + 1]) {
      args.budgetsFile = argv[++i];
    }
  }
  return args;
}

const { wasmDir: wasmDirArg, budgetsFile: budgetsFileArg } = parseArgs(
  process.argv.slice(2)
);

const WASM_DIR = resolve(
  wasmDirArg ||
    join(REPO_ROOT, "contracts", "target", "wasm32-unknown-unknown", "release")
);

const BUDGETS_FILE = resolve(
  budgetsFileArg || join(__dirname, "wasm-size-budgets.json")
);

// ── Load budgets ─────────────────────────────────────────────────────

/** @type {Record<string, number>} */
let budgets;
try {
  const raw = readFileSync(BUDGETS_FILE, "utf8");
  budgets = JSON.parse(raw);
  // Strip comment keys (keys starting with "_")
  for (const key of Object.keys(budgets)) {
    if (key.startsWith("_")) delete budgets[key];
  }
} catch (err) {
  console.error(`[check-wasm-size] Failed to load budgets from ${BUDGETS_FILE}: ${err.message}`);
  process.exit(1);
}

// ── Discover WASM files ──────────────────────────────────────────────

/** @returns {Array<{name: string, path: string, bytes: number}>} */
function discoverWasmFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory may not exist when running tests without a real build
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".wasm"))
    .map((f) => {
      const filePath = join(dir, f);
      const bytes = statSync(filePath).size;
      const name = f.replace(/\.wasm$/, "");
      return { name, path: filePath, bytes };
    });
}

const wasmFiles = discoverWasmFiles(WASM_DIR);

// ── Compare sizes against budgets ────────────────────────────────────

const COL_NAME = 30;
const COL_SIZE = 12;
const COL_BUDGET = 12;
const COL_STATUS = 10;

function pad(str, width) {
  return String(str).padEnd(width);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

console.log();
console.log(
  pad("Contract", COL_NAME) +
    pad("Size", COL_SIZE) +
    pad("Budget", COL_BUDGET) +
    pad("Status", COL_STATUS)
);
console.log("-".repeat(COL_NAME + COL_SIZE + COL_BUDGET + COL_STATUS));

let failed = 0;

// Report contracts found on disk
for (const { name, bytes } of wasmFiles) {
  const budget = budgets[name];
  if (budget === undefined) {
    console.log(
      pad(name, COL_NAME) +
        pad(fmtBytes(bytes), COL_SIZE) +
        pad("(no budget)", COL_BUDGET) +
        pad("⚠ SKIP", COL_STATUS)
    );
    continue;
  }

  const ok = bytes <= budget;
  if (!ok) failed++;

  console.log(
    pad(name, COL_NAME) +
      pad(fmtBytes(bytes), COL_SIZE) +
      pad(fmtBytes(budget), COL_BUDGET) +
      pad(ok ? "✓ OK" : "✗ OVER", COL_STATUS)
  );
}

// Warn about budgeted contracts with no WASM on disk (only when the dir exists)
let dirExists = false;
try {
  readdirSync(WASM_DIR);
  dirExists = true;
} catch {
  /* dir absent — likely running in test mode */
}

if (dirExists) {
  const foundNames = new Set(wasmFiles.map((f) => f.name));
  for (const name of Object.keys(budgets)) {
    if (!foundNames.has(name)) {
      console.log(
        pad(name, COL_NAME) +
          pad("(not found)", COL_SIZE) +
          pad(fmtBytes(budgets[name]), COL_BUDGET) +
          pad("⚠ MISS", COL_STATUS)
      );
    }
  }
}

console.log();

// ── Exit ─────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(
    `[check-wasm-size] ${failed} contract(s) exceed their WASM size budget.`
  );
  console.error(
    "[check-wasm-size] To raise a budget, update scripts/wasm-size-budgets.json and document the reason in your PR."
  );
  process.exit(1);
} else {
  console.log("[check-wasm-size] All contracts within budget.");
}
