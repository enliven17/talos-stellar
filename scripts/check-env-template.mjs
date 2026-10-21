#!/usr/bin/env node
/**
 * check-env-template.mjs
 *
 * Verifies that every process.env.VAR_NAME used in web/src/lib/*config*.ts
 * (and the health-probe utils) appears as a declared entry in web/.env.example.
 *
 * A variable is considered "declared" if any line in .env.example either:
 *   - starts with the variable name followed by '=' (active entry), or
 *   - contains the variable name after a leading '#' comment marker
 *     (commented-out / optional entry).
 *
 * Usage:
 *   node scripts/check-env-template.mjs
 *
 * Exit codes:
 *   0 — all variables are covered
 *   1 — one or more variables are missing; missing names printed to stderr
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Paths ─────────────────────────────────────────────────────────────────

const TEMPLATE_PATH = join(ROOT, "web", ".env.example");

/** Source directories / files to scan for process.env.X references. */
const SCAN_PATHS = [
  join(ROOT, "web", "src", "lib"),
  join(ROOT, "web", "src", "app", "api", "health"),
];

// ── Variables to always skip ──────────────────────────────────────────────
// Built-in / framework / purely internal variables that intentionally live
// outside .env.example.
const SKIP_VARS = new Set([
  "NODE_ENV",           // set by the runtime / framework
  "NEXT_PHASE",         // Next.js internal build phase marker
  // The NEXT_PUBLIC_ variant of STELLAR_ALLOW_CUSTOM_USDC_ISSUER is covered
  // by the STELLAR_ALLOW_CUSTOM_USDC_ISSUER comment in .env.example.
  "NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER",
]);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Recursively collect all .ts files whose name contains "config" (case-insensitive)
 * under the given directory, or return [path] if path is a file.
 */
function collectConfigFiles(dirOrFile) {
  try {
    const stat = statSync(dirOrFile);
    if (stat.isFile()) return [dirOrFile];

    const results = [];
    for (const entry of readdirSync(dirOrFile, { withFileTypes: true })) {
      const full = join(dirOrFile, entry.name);
      if (entry.isDirectory()) {
        // Recurse but skip __tests__ and node_modules
        if (entry.name !== "__tests__" && entry.name !== "node_modules") {
          results.push(...collectConfigFiles(full));
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        entry.name.toLowerCase().includes("config")
      ) {
        results.push(full);
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Extract every process.env.VAR_NAME string from source text.
 * Handles both process.env.VAR and process.env["VAR"] forms.
 */
function extractEnvVars(source) {
  const vars = new Set();
  // process.env.VAR_NAME (must be at least 2 chars to avoid single-letter false positives)
  for (const [, name] of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,})/g)) {
    vars.add(name);
  }
  // process.env["VAR_NAME"] or process.env['VAR_NAME'] (literal string only)
  for (const [, name] of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) {
    vars.add(name);
  }
  return vars;
}

/**
 * Build a set of variable names that are declared (active or commented) in
 * the .env.example template.
 */
function extractTemplateVars(templateText) {
  const declared = new Set();
  for (const rawLine of templateText.split("\n")) {
    const line = rawLine.trim();

    // Active entry:  KEY=...
    const activeMatch = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (activeMatch) {
      declared.add(activeMatch[1]);
      continue;
    }

    // Commented entry: # KEY=... or # KEY is mentioned in a comment line
    // We look for an uppercase identifier immediately following optional
    // whitespace after the '#'.
    const commentedMatch = line.match(/^#\s*([A-Z][A-Z0-9_]*)=/);
    if (commentedMatch) {
      declared.add(commentedMatch[1]);
    }
  }
  return declared;
}

// ── Main ──────────────────────────────────────────────────────────────────

const templateText = readFileSync(TEMPLATE_PATH, "utf8");
const templateVars = extractTemplateVars(templateText);

// Collect all config source files
const configFiles = SCAN_PATHS.flatMap(collectConfigFiles);

if (configFiles.length === 0) {
  process.stderr.write("check-env-template: no config files found to scan\n");
  process.exit(1);
}

// Gather all used env vars across all config files
const usedVars = new Set();
for (const file of configFiles) {
  const source = readFileSync(file, "utf8");
  for (const v of extractEnvVars(source)) {
    usedVars.add(v);
  }
}

// Check coverage
const missing = [];
for (const v of [...usedVars].sort()) {
  if (SKIP_VARS.has(v)) continue;
  if (!templateVars.has(v)) {
    missing.push(v);
  }
}

if (missing.length === 0) {
  const fileCount = configFiles.length;
  const varCount = usedVars.size - SKIP_VARS.size;
  process.stdout.write(
    `check-env-template: ✅  all ${varCount} env vars from ${fileCount} config file(s) are covered by web/.env.example\n`,
  );
  process.exit(0);
} else {
  process.stderr.write(
    `check-env-template: ❌  ${missing.length} env var(s) used in web/src/lib/*config*.ts are missing from web/.env.example:\n`,
  );
  for (const v of missing) {
    process.stderr.write(`  - ${v}\n`);
  }
  process.stderr.write(
    `\nAdd the missing variable(s) (active or commented-out) to web/.env.example and re-run.\n`,
  );
  process.exit(1);
}
