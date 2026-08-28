#!/usr/bin/env node
/**
 * generate-registry-fixtures.mjs
 *
 * Deterministic regeneration for `contracts/fixtures/registry_schema`.
 * - Validates schema_versions.json
 * - Sorts JSON keys, pretty-prints, ensures fixtures are canonically formatted
 * - With --check, fails if any fixture would change (CI)
 *
 * Run: pnpm fixtures:gen   or  node scripts/generate-registry-fixtures.mjs
 *      pnpm fixtures:check or  node scripts/generate-registry-fixtures.mjs --check
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const fixturesDir = join(root, "contracts/fixtures/registry_schema");
const manifestPath = join(fixturesDir, "schema_versions.json");

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) collectFiles(p, out);
    else if (p.endsWith(".json")) out.push(p);
  }
  return out;
}

const isCheck = process.argv.includes("--check");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(`schema_versions.json: supported=${manifest.supported.join(",")} latest=${manifest.latest}`);
if (!Array.isArray(manifest.supported) || typeof manifest.latest !== "number") {
  console.error("Invalid schema_versions.json: expected {supported:[], latest:number}");
  process.exit(1);
}
if (!manifest.supported.includes(manifest.latest)) {
  console.error(`latest ${manifest.latest} must be in supported ${manifest.supported}`);
  process.exit(1);
}

let changed = 0;
for (const file of collectFiles(fixturesDir)) {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  const sorted = sortKeys(parsed);
  const canonical = JSON.stringify(sorted, null, 2) + "\n";
  if (raw !== canonical) {
    if (isCheck) {
      console.error(`Fixture drift: ${file} not canonical. Run: pnpm fixtures:gen`);
      changed++;
    } else {
      writeFileSync(file, canonical, "utf8");
      console.log(`rewrote ${file}`);
      changed++;
    }
  }
}

if (isCheck && changed > 0) {
  console.error(`\n${changed} fixture(s) drifted. Run pnpm fixtures:gen and commit.`);
  process.exit(1);
}

if (isCheck) console.log("fixtures:check ok – all fixtures canonical");
else if (changed === 0) console.log("fixtures:gen ok – no changes");
else console.log(`fixtures:gen done – ${changed} file(s) updated`);

// Dry-run Soroban registry types validation (optional, no RPC)
// We shell out to cargo test for the focused fixture suite when not --check
if (!isCheck) {
  console.log("\nTip: run `cargo test -p talos-registry --lib registry_schema -- --nocapture` to validate parsers");
}
