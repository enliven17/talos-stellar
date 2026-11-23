#!/usr/bin/env node
/**
 * check-package-artifacts.mjs
 *
 * Pre-packaging gate for the published entry points of a workspace package.
 *
 * `npm pack` copies whatever the export map points at, so a typo in
 * `package.json` ships a tarball with a broken entry point. This check reads
 * every published entry (`exports`, `main`, `module`, `types`, `browser`, and
 * `bin`) and rejects a target before packaging when it:
 *
 *   - is missing from the built package,
 *   - is not a regular file,
 *   - is absolute or contains a `..` segment,
 *   - resolves outside the package directory, or
 *   - resolves outside it through a symlink.
 *
 * It runs after the build, because the targets only exist once the package has
 * been compiled. Usage:
 *
 *   pnpm --dir packages/sdk build
 *   node scripts/check-package-artifacts.mjs
 *   node scripts/check-package-artifacts.mjs --package packages/sdk --json
 *   pnpm artifacts:check
 *
 * Exit codes:
 *   0 - every published entry resolves inside its package
 *   1 - at least one target is missing or escapes the package
 *   2 - usage error, or a manifest could not be read
 *
 * Reports only use package-relative paths and field names, never absolute host
 * paths, so they are safe to attach to an issue or CI log.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRING_FIELDS = ["main", "module", "types"];

/** Compare strings by code point so discovery order is stable. */
function comparePaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkTargets(field, value, targets) {
  if (typeof value === "string") {
    targets.push({ field, target: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkTargets(`${field}[${index}]`, item, targets));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      walkTargets(`${field}[${JSON.stringify(key)}]`, item, targets);
    }
    return;
  }
  if (value !== null && value !== undefined) {
    targets.push({ field, target: value });
  }
}

/**
 * Collect every published entry point declared by a manifest.
 *
 * `null` export leaves are skipped: they intentionally block a subpath. Arrays
 * are supported because Node resolves them in order.
 *
 * @param {object} pkg parsed package.json
 * @returns {Array<{ field: string, target: unknown }>}
 */
export function collectPublishedTargets(pkg) {
  const targets = [];

  if (pkg.exports !== undefined) walkTargets("exports", pkg.exports, targets);
  for (const field of STRING_FIELDS) {
    if (pkg[field] !== undefined) walkTargets(field, pkg[field], targets);
  }
  if (pkg.browser !== undefined) walkTargets("browser", pkg.browser, targets);
  if (pkg.bin !== undefined) walkTargets("bin", pkg.bin, targets);

  return targets;
}

/** True when `child` is strictly inside `parent` after resolution. */
function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

/**
 * Validate one published target against the package directory.
 *
 * @returns {string | null} an actionable error, or null when the target is safe
 */
export function validateTarget(packageDir, target) {
  if (typeof target !== "string") {
    return `must be a string, got ${target === null ? "null" : typeof target}`;
  }
  if (target.length === 0) return "must not be empty";
  if (target.includes("\0")) return "must not contain NUL bytes";
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/") || target.startsWith("\\")) {
    return "must be a path relative to the package root";
  }
  if (target.replace(/\\/g, "/").split("/").includes("..")) {
    return "must not escape the package root";
  }

  const absolute = resolve(packageDir, target);
  if (!isInside(resolve(packageDir), absolute)) {
    return "resolves outside the package root";
  }
  if (!existsSync(absolute)) {
    return "does not exist in the built package (run the package build first)";
  }

  const link = lstatSync(absolute);
  if (link.isSymbolicLink() && !isInside(realpathSync(packageDir), realpathSync(absolute))) {
    return "resolves outside the package root through a symlink";
  }
  if (!statSync(absolute).isFile()) {
    return "is not a regular file";
  }
  return null;
}

/**
 * Validate every published entry of one package.
 *
 * @param {{ packageDir: string, label?: string, pkg: object }} options
 */
export function checkPackage({ packageDir, label = packageDir, pkg }) {
  const root = resolve(packageDir);
  const entries = collectPublishedTargets(pkg).map(({ field, target }) => {
    const error = validateTarget(root, target);
    return { field, target, ok: error === null, error };
  });

  return {
    label,
    ok: entries.every((entry) => entry.ok),
    entries,
    errors: entries
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.field} -> ${String(entry.target)}: ${entry.error}`),
  };
}

/**
 * Discover publishable workspace packages under `<root>/packages`.
 *
 * @param {string} root repository root
 * @returns {Array<{ packageDir: string, label: string, pkg: object }>}
 */
export function discoverPackages(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((packageDir) => existsSync(join(packageDir, "package.json")))
    .map((packageDir) => ({
      packageDir,
      label: relative(root, packageDir).split(sep).join("/"),
      pkg: JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")),
    }))
    .filter(({ pkg }) => pkg.private !== true && collectPublishedTargets(pkg).length > 0)
    .sort((a, b) => comparePaths(a.label, b.label));
}

export function formatReport(results) {
  const lines = ["Talos release artifact path check"];
  for (const result of results) {
    if (result.ok) {
      lines.push(`✓ ${result.label}: ${result.entries.length} published target(s) resolve inside the package`);
      continue;
    }
    lines.push(`✗ ${result.label}: ${result.errors.length} invalid published target(s)`);
    for (const error of result.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: node scripts/check-package-artifacts.mjs [--package <dir>]... [--json]",
  );
  console.error("  --package <dir>  package directory to check (repeatable; default: all publishable packages)");
  console.error("  --json           print a machine-readable report");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, packages: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--package") {
      const packageDir = argv[index + 1];
      if (!packageDir) usage("--package requires a directory");
      options.packages.push({ packageDir: resolve(packageDir), label: packageDir });
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function loadPackage({ packageDir, label }) {
  const manifest = join(packageDir, "package.json");
  if (!existsSync(manifest)) {
    throw new Error(`${label} has no package.json`);
  }
  return {
    packageDir,
    label,
    pkg: JSON.parse(readFileSync(manifest, "utf8")),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let packages;
  try {
    packages = options.packages.length > 0
      ? options.packages.map(loadPackage)
      : discoverPackages(REPO_ROOT);
  } catch (error) {
    console.error(`error: could not read package manifest: ${error.message}`);
    process.exit(2);
  }

  if (packages.length === 0) {
    console.error("error: no publishable package with published entry points was found");
    process.exit(2);
  }

  const results = packages.map(checkPackage);

  if (options.json) {
    console.log(JSON.stringify({ ok: results.every((result) => result.ok), packages: results }, null, 2));
  } else {
    console.log(formatReport(results));
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
