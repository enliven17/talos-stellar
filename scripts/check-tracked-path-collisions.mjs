#!/usr/bin/env node
/**
 * check-tracked-path-collisions.mjs
 *
 * Cross-platform checkout gate for case-only tracked path collisions.
 *
 * Git stores paths case-sensitively, but Windows and default macOS volumes are
 * case-insensitive. A repository that tracks `docs/README.md` and
 * `docs/readme.md` clones fine on Linux and then silently drops or overwrites
 * one of the files on those platforms. This check lists the tracked paths and
 * reports every group whose members differ only by case, before a checkout is
 * packaged for another platform.
 *
 * Paths are compared after normalising separators to "/" and folding case.
 * Directory-only case differences (`Docs/a.md` vs `docs/b.md`) are not
 * collisions: they map to different files on every platform. A file that
 * collides with a directory of the same folded name (`docs/Replay.md` next to
 * `docs/replay.md/notes.md`) is reported, because the checkout cannot create
 * both on a case-insensitive filesystem.
 *
 * Usage:
 *   node scripts/check-tracked-path-collisions.mjs
 *   node scripts/check-tracked-path-collisions.mjs --json
 *   node scripts/check-tracked-path-collisions.mjs --root path/to/checkout
 *   pnpm paths:check
 *
 * Exit codes:
 *   0 - no case collisions
 *   1 - at least one case collision was found
 *   2 - usage error, or tracked paths could not be read
 *
 * Output is deterministic: collision groups and the paths inside each group are
 * sorted by code point, never by locale. Only repository-relative paths are
 * printed, so the report is safe to attach to an issue or CI log.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Compare strings by code point so ordering is stable across platforms. */
export function comparePaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Fold a tracked path into the key used for case-insensitive comparison. */
export function collisionKey(path) {
  return String(path)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * Group tracked paths into collision groups and return only the groups that
 * cannot coexist on a case-insensitive filesystem.
 *
 * Two paths collide when their case-folded forms are equal, or when one folded
 * form is a directory prefix of the other (`docs/replay.md` as a file and
 * `docs/replay.md/notes.md` as a directory). Prefix groups are merged so a
 * whole conflicting subtree is reported once.
 *
 * @param {string[]} paths repository-relative paths (git prints "/" separators)
 * @returns {Array<{ key: string, paths: string[] }>} sorted collision groups
 */
export function findCaseCollisions(paths) {
  const groups = new Map();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) continue;
    const key = collisionKey(path);
    const members = groups.get(key);
    if (members) {
      members.add(path);
    } else {
      groups.set(key, new Set([path]));
    }
  }

  const parent = new Map([...groups.keys()].map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== root) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const key of groups.keys()) {
    const segments = key.split("/");
    let prefix = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index];
      if (groups.has(prefix)) union(prefix, key);
    }
  }

  const components = new Map();
  for (const key of groups.keys()) {
    const root = find(key);
    const component = components.get(root);
    if (component) {
      component.keys.push(key);
      for (const path of groups.get(key)) component.paths.add(path);
    } else {
      components.set(root, { keys: [key], paths: new Set(groups.get(key)) });
    }
  }

  const collisions = [];
  for (const component of components.values()) {
    const totalPaths = component.paths.size;
    if (component.keys.length < 2 && totalPaths < 2) continue;
    collisions.push({
      key: component.keys.sort(comparePaths)[0],
      paths: [...component.paths].sort(comparePaths),
    });
  }
  return collisions.sort((a, b) => comparePaths(a.key, b.key));
}

/**
 * Read the tracked paths for a checkout.
 *
 * @param {string} root checkout root
 * @returns {{ ok: boolean, paths?: string[], error?: string }}
 */
export function readTrackedPaths(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || "").trim() || `git ls-files exited with status ${result.status}`,
    };
  }

  return {
    ok: true,
    paths: (result.stdout || "").split("\0").filter((path) => path.length > 0),
  };
}

export function formatReport({ checked, collisions }) {
  if (collisions.length === 0) {
    return `✓ No case collisions across ${checked} tracked path${checked === 1 ? "" : "s"}.`;
  }

  const affected = collisions.reduce((total, group) => total + group.paths.length, 0);
  const lines = [
    `✗ ${collisions.length} case collision${collisions.length === 1 ? "" : "s"} ` +
      `across ${affected} tracked path${affected === 1 ? "" : "s"}:`,
  ];
  for (const group of collisions) {
    lines.push(`  ${group.key}`);
    for (const path of group.paths) lines.push(`    - ${path}`);
  }
  lines.push(
    "  Rename one path in each group so the checkout does not lose files on",
    "  case-insensitive filesystems (Windows, default macOS).",
  );
  return lines.join("\n");
}

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: node scripts/check-tracked-path-collisions.mjs [--json] [--root <dir>]",
  );
  console.error("  --json        print a machine-readable report");
  console.error("  --root <dir>  checkout to inspect (default: repository root)");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false, root: REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--root") {
      const root = argv[index + 1];
      if (!root) usage("--root requires a directory");
      options.root = resolve(root);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tracked = readTrackedPaths(options.root);

  if (!tracked.ok) {
    console.error(`error: could not list tracked paths: ${tracked.error}`);
    process.exit(2);
  }

  const collisions = findCaseCollisions(tracked.paths);
  const report = { checked: tracked.paths.length, collisions };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  process.exitCode = collisions.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
