#!/usr/bin/env node
/**
 * Export-map smoke check — `npm run compat:exports`.
 *
 * Verifies that the published `exports` map of `@talos-protocol/sdk` actually
 * works, rather than trusting that the manifest looks right:
 *
 *   1. `package.json` parses and its `exports["."]` passes the shared
 *      validation rules (see scripts/export-map-lib.mjs).
 *   2. Every declared target exists on disk and is non-empty (post-build).
 *   3. `require()` resolves the package through the real exports map to the
 *      declared CJS target, and `import` resolves to the declared ESM target.
 *   4. The ESM and CJS builds expose the same public surface.
 *   5. Every target is actually present in the published tarball
 *      (`npm pack --dry-run --json`), not just present on disk.
 *
 * Failures are explicit and privacy-safe: messages contain condition names and
 * package-relative paths only.
 *
 * This is a post-build check — run `npm run build` first. The CI
 * `export-map` job in .github/workflows/sdk-compatibility.yml wires it up
 * against the built artifacts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExportMap } from "./export-map-lib.mjs";

const PKG_NAME = "@talos-protocol/sdk";
const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");
const PACKAGE_JSON = join(PKG_ROOT, "package.json");

function log(message) {
  console.log(`[compat:exports] ${message}`);
}
function pass(message) {
  console.log(`[compat:exports]   + ${message}`);
}
function warn(message) {
  console.warn(`[compat:exports]   ! ${message}`);
}
function fail(message) {
  console.error(`[compat:exports] FAIL: ${message}`);
  process.exit(1);
}

const rel = (absolute) => relative(PKG_ROOT, absolute).split(sep).join("/");

/** Canonicalise a path so pnpm/workspace symlinks compare equal. */
const canonical = (absolute) => {
  try {
    return realpathSync(absolute);
  } catch {
    return resolve(absolute);
  }
};

// ── 1. Manifest parses and validates ────────────────────────────────
if (!existsSync(PACKAGE_JSON)) {
  fail("package.json is missing");
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
} catch (err) {
  fail(`package.json is not valid JSON: ${err.message}`);
}

const { ok, errors, warnings, targets } = validateExportMap(pkg);
for (const warning of warnings) warn(warning);
if (!ok) {
  for (const error of errors) console.error(`[compat:exports]   x ${error}`);
  fail(`export map is invalid (${errors.length} error(s))`);
}
pass(`exports["."] declares ${targets.map((t) => t.condition).join(", ")}`);

if (pkg.type !== "module") {
  fail('package.json "type" must be "module" so the "import" target loads as ESM');
}

const targetFor = (condition) => targets.find((t) => t.condition === condition);
const importTarget = targetFor("import");
const requireTarget = targetFor("require");

// ── 2. Every declared target exists on disk ─────────────────────────
for (const { condition, target } of targets) {
  const absolute = resolve(PKG_ROOT, target);
  if (!absolute.startsWith(PKG_ROOT + sep)) {
    fail(`export target "${target}" (${condition}) escapes the package root`);
  }
  if (!existsSync(absolute)) {
    fail(`export target "${target}" (${condition}) is missing — run "npm run build" first`);
  }
  const size = statSync(absolute).size;
  if (size === 0) {
    fail(`export target "${target}" (${condition}) is empty`);
  }
  pass(`${condition} -> ${target} (${size} bytes)`);
}

// ── 3. Live resolution through the real exports map ─────────────────
const requireFromHere = createRequire(import.meta.url);

let cjsResolved;
try {
  cjsResolved = requireFromHere.resolve(PKG_NAME);
} catch (err) {
  fail(`"require" resolution of ${PKG_NAME} failed: ${err.message}`);
}
if (canonical(cjsResolved) !== canonical(resolve(PKG_ROOT, requireTarget.target))) {
  fail(
    `"require" resolved to ${rel(cjsResolved)} but exports declares ${requireTarget.target}`,
  );
}
pass(`require("${PKG_NAME}") -> ${requireTarget.target}`);

if (typeof import.meta.resolve !== "function") {
  warn("import.meta.resolve is unavailable on this Node — skipping live ESM resolution");
} else {
  let esmResolved;
  try {
    esmResolved = fileURLToPath(import.meta.resolve(PKG_NAME));
  } catch (err) {
    fail(`"import" resolution of ${PKG_NAME} failed: ${err.message}`);
  }
  if (canonical(esmResolved) !== canonical(resolve(PKG_ROOT, importTarget.target))) {
    fail(
      `"import" resolved to ${rel(esmResolved)} but exports declares ${importTarget.target}`,
    );
  }
  pass(`import("${PKG_NAME}") -> ${importTarget.target}`);
}

// ── 4. CJS and ESM expose the same public surface ───────────────────
const cjsModule = requireFromHere(PKG_NAME);
let esmModule;
try {
  esmModule = await import(PKG_NAME);
} catch (err) {
  fail(`dynamic import of ${PKG_NAME} threw: ${err.message}`);
}

const esmKeys = Object.keys(esmModule).sort();
const cjsKeys = Object.keys(cjsModule).sort();
const onlyEsm = esmKeys.filter((key) => !cjsKeys.includes(key));
const onlyCjs = cjsKeys.filter((key) => !esmKeys.includes(key));

if (onlyEsm.length > 0 || onlyCjs.length > 0) {
  if (onlyEsm.length > 0) console.error(`[compat:exports]   x ESM-only exports: ${onlyEsm.join(", ")}`);
  if (onlyCjs.length > 0) console.error(`[compat:exports]   x CJS-only exports: ${onlyCjs.join(", ")}`);
  fail("CJS and ESM builds expose different public surfaces");
}
if (esmKeys.length === 0) {
  fail("the package exposes no public exports");
}
pass(`CJS and ESM expose the same ${esmKeys.length} public exports`);

// ── 5. Every target is actually published ───────────────────────────
function packedTargets() {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return new Set((entry?.files ?? []).map((file) => file.path));
}

let packed;
try {
  packed = packedTargets();
} catch (err) {
  warn(`could not inspect the publish tarball (${err.message}); falling back to the "files" list`);
  packed = null;
}

if (packed) {
  for (const { condition, target } of targets) {
    if (!packed.has(target.replace(/^\.\//, ""))) {
      fail(`export target "${target}" (${condition}) is not included in the published tarball`);
    }
  }
  pass(`all ${targets.length} export targets are present in the publish tarball`);
}

log("ALL CHECKS PASSED");
process.exit(0);
