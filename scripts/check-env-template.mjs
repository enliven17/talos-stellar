#!/usr/bin/env node
/**
 * check-env-template.mjs
 *
 * Validates that every process.env.<VAR> reference in web/src/lib/*config*.ts
 * (and admin-auth.ts) appears in web/.env.example, so the template never drifts
 * behind the code.
 *
 * Runtime-injected names that are not meaningful to configure (NODE_ENV,
 * NEXT_PHASE, and single-letter placeholders) are excluded from the check via
 * EXCLUDED_VARS below.
 *
 * Usage:
 *   node scripts/check-env-template.mjs
 *   node scripts/check-env-template.mjs --json
 *   pnpm env:template:check
 *
 * Exit codes:
 *   0 — all vars present in template
 *   1 — one or more vars are missing
 *   2 — usage / argument error
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Source files (relative to repoRoot) to scan for process.env references.
 * Using explicit paths avoids a glob dependency and is unambiguous.
 */
const SOURCE_FILES = [
  "web/src/lib/stellar-config.ts",
  "web/src/lib/backup-config.ts",
  "web/src/lib/jobs/config.ts",
  "web/src/lib/outbox/config.ts",
  "web/src/lib/reconciler/config.ts",
  "web/src/lib/webhooks/config.ts",
  "web/src/lib/idempotency/config.ts",
  "web/src/lib/admin-auth.ts",
];

/** Path to the canonical environment template. */
const TEMPLATE_PATH = join(repoRoot, "web", ".env.example");

/**
 * Variables intentionally excluded from the template check.
 *
 * NODE_ENV and NEXT_PHASE are set by the runtime/framework, not by operators.
 * Single-letter names (e.g. "X") are false-positive captures from patterns like
 * `process.env[someVar]` parsed as `process.env.X`.
 */
const EXCLUDED_VARS = new Set([
  "NODE_ENV",
  "NEXT_PHASE",
  // Single-letter false positives from indexed access expressions
  "X",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node scripts/check-env-template.mjs [--json]");
  console.error("  --json    Output results as JSON");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { json: false };
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  return opts;
}

/** Extract all process.env.VAR_NAME references from source text. */
function extractEnvVars(source) {
  const vars = new Set();
  // Match process.env.FOO_BAR style references
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    vars.add(m[1]);
  }
  return vars;
}

/** Parse all key names present in the template (both set and commented-out). */
function parseTemplateKeys(templateContent) {
  const keys = new Set();
  for (const line of templateContent.split("\n")) {
    // Match both active keys (KEY=value) and commented keys (# KEY=value or # KEY=)
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Resolve the source file list, auto-discovering any new *config*.ts files
 * added under web/src/lib that are not already in SOURCE_FILES.
 */
function resolveSourceFiles() {
  const known = new Set(SOURCE_FILES.map((f) => join(repoRoot, f)));
  const discovered = new Set(known);

  // Walk web/src/lib (one level + subdirs) and pick up *config*.ts files
  function walkDir(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walkDir(join(dir, entry.name));
      } else if (
        entry.isFile() &&
        entry.name.includes("config") &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        discovered.add(join(dir, entry.name));
      }
    }
  }

  walkDir(join(repoRoot, "web", "src", "lib"));
  return [...discovered].filter((f) => existsSync(f));
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.json ? () => {} : console.log.bind(console);

  // 1. Verify the template exists
  if (!existsSync(TEMPLATE_PATH)) {
    const msg = `web/.env.example not found at ${TEMPLATE_PATH}`;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, errors: [msg], missing: [], scannedFiles: [], templateKeys: [] }, null, 2));
    } else {
      console.error(`✗ ${msg}`);
    }
    process.exit(1);
  }

  // 2. Collect env var references from source files
  const sourceFiles = resolveSourceFiles();

  if (sourceFiles.length === 0) {
    const msg = "No source files found to scan.";
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, errors: [msg], missing: [], scannedFiles: [], templateKeys: [] }, null, 2));
    } else {
      console.error(`✗ ${msg}`);
    }
    process.exit(1);
  }

  log(`Scanning ${sourceFiles.length} source file(s) for process.env references…`);

  /** Map from VAR_NAME → Set of source files that reference it */
  const varToFiles = new Map();

  for (const filePath of sourceFiles) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch (e) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, errors: [`Cannot read ${filePath}: ${e.message}`], missing: [], scannedFiles: sourceFiles, templateKeys: [] }, null, 2));
      } else {
        console.error(`✗ Cannot read ${filePath}: ${e.message}`);
      }
      process.exit(1);
    }

    const vars = extractEnvVars(source);
    for (const v of vars) {
      if (EXCLUDED_VARS.has(v)) continue;
      if (!varToFiles.has(v)) varToFiles.set(v, new Set());
      varToFiles.get(v).add(filePath.replace(repoRoot + "/", ""));
    }
  }

  // 3. Parse the template
  const templateContent = readFileSync(TEMPLATE_PATH, "utf8");
  const templateKeys = parseTemplateKeys(templateContent);

  log(`Found ${varToFiles.size} env var(s) across ${sourceFiles.length} file(s).`);
  log(`Template has ${templateKeys.size} key(s).`);

  // 4. Find missing vars
  const missing = [];
  for (const [varName, files] of [...varToFiles.entries()].sort()) {
    if (!templateKeys.has(varName)) {
      missing.push({ variable: varName, files: [...files].sort() });
    }
  }

  // 5. Output
  const scannedFiles = sourceFiles.map((f) => f.replace(repoRoot + "/", "")).sort();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: missing.length === 0,
          missing,
          scannedFiles,
          templateKeys: [...templateKeys].sort(),
          errors: missing.map(
            ({ variable, files }) =>
              `${variable} is used in ${files.join(", ")} but missing from web/.env.example`,
          ),
        },
        null,
        2,
      ),
    );
    process.exit(missing.length > 0 ? 1 : 0);
  }

  if (missing.length > 0) {
    console.error(`✗ ${missing.length} env var(s) used in config files but absent from web/.env.example:\n`);
    for (const { variable, files } of missing) {
      console.error(`  ${variable}`);
      for (const f of files) console.error(`    ← ${f}`);
    }
    console.error(
      `\nAdd the missing var(s) to web/.env.example (commented-out entries are fine),\nthen re-run: node scripts/check-env-template.mjs`,
    );
    process.exit(1);
  }

  console.log(
    `✓ All ${varToFiles.size} env var(s) from config files are documented in web/.env.example.`,
  );
}

main();
