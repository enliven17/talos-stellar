#!/usr/bin/env node
/**
 * Manifest <-> lockfile drift check for Node packages (offline).
 *
 * Compares the `dependencies` / `devDependencies` / `peerDependencies` /
 * `optionalDependencies` declared in a `package.json` manifest against the
 * specifiers recorded for that package in either a pnpm or npm lockfile.
 * Succeeds (exit 0) when they agree and fails (exit 1) with an actionable
 * message when the lockfile is stale or the manifest and lockfile diverge.
 *
 * This is a deterministic, network-free first-pass check. CI also runs the
 * authoritative `pnpm install --frozen-lockfile` (see scripts/verify-lockfiles.sh).
 *
 * Usage:
 *   node scripts/check-node-lock.js \
 *     --manifest <path-to/package.json> \
 *     --lock     <path-to/pnpm-lock.yaml-or-package-lock.json> \
 *     [--package <importer-or-root-key>]
 *
 * `--package` selects the lockfile entry that records this package:
 *   - pnpm lockfiles: the importer key, e.g. `web`, `contracts`, `packages/sdk`.
 *   - npm lockfiles:  the root package entry key (usually "").
 * When omitted it defaults to the manifest's `name` for pnpm locks and `""`
 * for npm locks.
 */

import { readFileSync } from "node:fs";

function usage() {
  process.stderr.write(
    "Usage: node scripts/check-node-lock.js --manifest <pkg.json> --lock <lockfile> [--package <key>]\n"
  );
  process.exit(2);
}

function args() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest" || a === "--lock" || a === "--package") {
      opts[a.slice(2)] = argv[++i];
    } else {
      usage();
    }
  }
  if (!opts.manifest || !opts.lock) usage();
  return opts;
}

const opt = args();
const manifestPath = opt.manifest;
const lockPath = opt.lock;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const raw = readFileSync(lockPath, "utf8");

function isYaml(raw) {
  return /(^|\n)lockfileVersion:\s*['"]?9/.test(raw);
}

const depKinds = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function manifestSpecs() {
  const specs = {};
  for (const kind of depKinds) {
    const block = manifest[kind] || {};
    for (const [name, spec] of Object.entries(block)) {
      specs[name] = { spec: String(spec), kind };
    }
  }
  return specs;
}

function lockSpecsNpm() {
  const lock = JSON.parse(raw);
  const rootKey = opt.package || "";
  const entry = lock.packages[rootKey];
  if (!entry) return {};
  const specs = {};
  for (const kind of depKinds) {
    const block = entry[kind] || {};
    for (const [name, spec] of Object.entries(block)) {
      specs[name] = { spec: String(spec), kind };
    }
  }
  return specs;
}

// pnpm importer specifiers are single-line: `name:` then indented `specifier:`.
// Names and specifiers may be quoted (when they contain special characters) or
// unquoted (for plain identifiers), so we tolerate both forms.
function lockSpecsPnpmSimple() {
  const pkgKey = opt.package || manifest.name || ".";
  const body = raw.split("\n");
  const start = body.findIndex((l) => l === `  ${pkgKey}:`);
  if (start === -1) return {};
  const specs = {};
  let i = start + 1;
  let currentKind = null;
  for (; i < body.length; i++) {
    const line = body[i];
    if (line.startsWith("  ") && !line.startsWith("    ")) break; // next importer
    if (line.startsWith("    ")) {
      const kindMatch = line.match(/^    (dependencies|devDependencies|peerDependencies|optionalDependencies):$/);
      if (kindMatch) {
        currentKind = kindMatch[1];
        continue;
      }
      const nameMatch = line.match(/^      '?([^:]+?)'?:$/);
      if (nameMatch && currentKind) {
        const name = nameMatch[1].replace(/^'|'$/g, "").trim();
        if (name) {
          const specLine = body[i + 1] || "";
          const specMatch = specLine.match(/^\s+specifier:\s*(.*)$/);
          if (specMatch) {
            specs[name] = { spec: specMatch[1].replace(/^'|'$/g, "").trim(), kind: currentKind };
          }
        }
      }
    }
  }
  return specs;
}

const declaredManifest = manifestSpecs();
const lockSpecs = isYaml(raw) ? lockSpecsPnpmSimple() : lockSpecsNpm();
const lockFormat = isYaml(raw) ? "pnpm" : "npm";

// Report problems.
const problems = [];
for (const [name, ms] of Object.entries(declaredManifest)) {
  const ls = lockSpecs[name];
  if (!ls) {
    problems.push(`- "${name}" (${ms.kind}) is declared in ${manifestPath} but missing from ${lockPath}. Run your package manager install (e.g. "pnpm install" / "npm install") and commit the updated lockfile.`);
  } else if (ls.spec && ls.spec !== ms.spec) {
    problems.push(`- "${name}" (${ms.kind}) specifier "${ms.spec}" in ${manifestPath} differs from "${ls.spec}" recorded in ${lockPath}.`);
  }
}
for (const [name, ls] of Object.entries(lockSpecs)) {
  if (!declaredManifest[name]) {
    problems.push(`- "${name}" (${ls.kind}) is recorded in ${lockPath} but absent from dependency blocks of ${manifestPath}.`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`LOCKFILE DRIFT DETECTED between ${manifestPath} and ${lockPath} (${lockFormat}):\n`);
  for (const p of problems) process.stderr.write(p + "\n");
  process.exit(1);
}

process.stdout.write(`OK ${manifestPath} <-> ${lockPath} (${lockFormat}) — in sync\n`);
process.exit(0);
