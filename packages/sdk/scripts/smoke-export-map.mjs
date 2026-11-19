#!/usr/bin/env node
/**
 * Export-map smoke check — `npm run compat:exports`.
 *
 * Verifies that the published `exports` map of `@talos-protocol/sdk` actually
 * works, rather than trusting that the manifest looks right:
 *
 *   1. `package.json` parses and every declared entry of its `exports` map —
 *      the root barrel and each subpath — passes the shared validation rules
 *      (see scripts/export-map-lib.mjs).
 *   2. Every declared target exists on disk and is non-empty (post-build).
 *   3. `require()` resolves each entry through the real exports map to the
 *      declared CJS target, and `import` resolves to the declared ESM target.
 *   4. The ESM and CJS builds expose the same public surface, per entry.
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
import { REQUIRED_SUBPATHS, validateExportMap } from "./export-map-lib.mjs";

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

/** The bare specifier that resolves to a given export-map key. */
const specifierFor = (subpath) =>
  subpath === "." ? PKG_NAME : `${PKG_NAME}${subpath.slice(1)}`;

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

const { ok, errors, warnings, subpaths } = validateExportMap(pkg);
for (const warning of warnings) warn(warning);
if (!ok) {
  for (const error of errors) console.error(`[compat:exports]   x ${error}`);
  fail(`export map is invalid (${errors.length} error(s))`);
}

const declared = subpaths.map((entry) => entry.subpath);
for (const required of REQUIRED_SUBPATHS) {
  if (!declared.includes(required)) {
    fail(`exports is missing the required "${required}" subpath`);
  }
}
for (const entry of subpaths) {
  pass(
    `exports[${JSON.stringify(entry.subpath)}] declares ` +
      entry.targets.map((t) => t.condition).join(", "),
  );
}

if (pkg.type !== "module") {
  fail('package.json "type" must be "module" so the "import" target loads as ESM');
}

const allTargets = subpaths.flatMap((entry) =>
  entry.targets.map((target) => ({ ...target, subpath: entry.subpath })),
);

// ── 2. Every declared target exists on disk ─────────────────────────
for (const { subpath, condition, target } of allTargets) {
  const absolute = resolve(PKG_ROOT, target);
  if (!absolute.startsWith(PKG_ROOT + sep)) {
    fail(`export target "${target}" (${subpath}.${condition}) escapes the package root`);
  }
  if (!existsSync(absolute)) {
    fail(
      `export target "${target}" (${subpath}.${condition}) is missing — ` +
        'run "npm run build" first',
    );
  }
  const size = statSync(absolute).size;
  if (size === 0) {
    fail(`export target "${target}" (${subpath}.${condition}) is empty`);
  }
  pass(`${subpath} ${condition} -> ${target} (${size} bytes)`);
}

// ── 3. Live resolution through the real exports map ─────────────────
const requireFromHere = createRequire(import.meta.url);

const esmResolveAvailable = typeof import.meta.resolve === "function";
if (!esmResolveAvailable) {
  warn("import.meta.resolve is unavailable on this Node — skipping live ESM resolution");
}

for (const entry of subpaths) {
  const specifier = specifierFor(entry.subpath);
  const targetFor = (condition) => entry.targets.find((t) => t.condition === condition);
  const importTarget = targetFor("import");
  const requireTarget = targetFor("require");

  let cjsResolved;
  try {
    cjsResolved = requireFromHere.resolve(specifier);
  } catch (err) {
    fail(`"require" resolution of ${specifier} failed: ${err.message}`);
  }
  if (canonical(cjsResolved) !== canonical(resolve(PKG_ROOT, requireTarget.target))) {
    fail(
      `require("${specifier}") resolved to ${rel(cjsResolved)} ` +
        `but exports declares ${requireTarget.target}`,
    );
  }
  pass(`require("${specifier}") -> ${requireTarget.target}`);

  if (!esmResolveAvailable) continue;

  let esmResolved;
  try {
    esmResolved = fileURLToPath(import.meta.resolve(specifier));
  } catch (err) {
    fail(`"import" resolution of ${specifier} failed: ${err.message}`);
  }
  if (canonical(esmResolved) !== canonical(resolve(PKG_ROOT, importTarget.target))) {
    fail(
      `import("${specifier}") resolved to ${rel(esmResolved)} ` +
        `but exports declares ${importTarget.target}`,
    );
  }
  pass(`import("${specifier}") -> ${importTarget.target}`);
}

// ── 4. CJS and ESM expose the same public surface, per entry ────────
for (const entry of subpaths) {
  const specifier = specifierFor(entry.subpath);

  let cjsModule;
  try {
    cjsModule = requireFromHere(specifier);
  } catch (err) {
    fail(`require("${specifier}") threw: ${err.message}`);
  }

  let esmModule;
  try {
    esmModule = await import(specifier);
  } catch (err) {
    fail(`dynamic import of ${specifier} threw: ${err.message}`);
  }

  const surface = (module) =>
    Object.keys(module)
      .filter((key) => key !== "default")
      .sort();

  const esmKeys = surface(esmModule);
  const cjsKeys = surface(cjsModule);
  const onlyEsm = esmKeys.filter((key) => !cjsKeys.includes(key));
  const onlyCjs = cjsKeys.filter((key) => !esmKeys.includes(key));

  if (onlyEsm.length > 0 || onlyCjs.length > 0) {
    if (onlyEsm.length > 0) {
      console.error(`[compat:exports]   x ${specifier} ESM-only exports: ${onlyEsm.join(", ")}`);
    }
    if (onlyCjs.length > 0) {
      console.error(`[compat:exports]   x ${specifier} CJS-only exports: ${onlyCjs.join(", ")}`);
    }
    fail(`CJS and ESM builds of ${specifier} expose different public surfaces`);
  }
  if (esmKeys.length === 0) {
    fail(`${specifier} exposes no public exports`);
  }
  pass(`${specifier} CJS and ESM expose the same ${esmKeys.length} public exports`);
}

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
  for (const { subpath, condition, target } of allTargets) {
    if (!packed.has(target.replace(/^\.\//, ""))) {
      fail(
        `export target "${target}" (${subpath}.${condition}) is not included in ` +
          "the published tarball",
      );
    }
  }
  pass(`all ${allTargets.length} export targets are present in the publish tarball`);
}

log("ALL CHECKS PASSED");
process.exit(0);
