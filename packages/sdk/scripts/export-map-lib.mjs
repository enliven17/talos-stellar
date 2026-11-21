/**
 * Export-map validation helpers for `@talos-protocol/sdk`.
 *
 * Single source of truth for the "are the CJS and ESM entry points wired up
 * correctly?" check. It is shared by:
 *
 *   • scripts/smoke-export-map.mjs — post-build runtime + publish check
 *                                    (`npm run compat:exports`).
 *   • tests/export-map.test.ts     — unit tests that run without a build.
 *
 * Everything here is pure: it never touches the filesystem, the network, or
 * `process`. Callers pass an already-parsed `package.json` object, so the same
 * rules apply to the real manifest and to synthetic negative fixtures.
 *
 * The root (`"."`) barrel is checked alongside every declared subpath
 * (`"./webhooks"`, `"./events"`, `"./errors"`), so a server-only entry point
 * cannot drift into a single-string shorthand or a CJS/ESM collision.
 *
 * Error/warning strings only ever contain condition names and package-relative
 * paths — never secrets, tokens, or absolute host paths.
 */

/** The barrel entry point every consumer gets by default. */
export const ROOT_SUBPATH = ".";

/** Conditions every published dual CJS/ESM entry point must declare. */
export const REQUIRED_CONDITIONS = Object.freeze(["import", "require", "types"]);

/** Conditions we understand but do not require. */
export const OPTIONAL_CONDITIONS = Object.freeze(["browser", "default"]);

/**
 * Server-only subpaths that must stay importable without the root barrel.
 *
 * The barrel pulls in `client.ts` and, through it, `@stellar/stellar-sdk`;
 * these entries exist so edge and serverless webhook consumers can bundle only
 * what they need. `tests/subpath-exports.test.ts` proves the modules behind
 * them stay free of the Stellar SDK.
 */
export const REQUIRED_SUBPATHS = Object.freeze(["./webhooks", "./events", "./errors"]);

/**
 * Extensions allowed per leaf condition. `.d.ts` is listed on its own so a
 * `.ts` target is not accidentally accepted for the `types` condition.
 */
const ALLOWED_EXTENSIONS = Object.freeze({
  import: [".js", ".mjs"],
  require: [".cjs", ".js"],
  types: [".d.ts"],
  browser: [".js", ".mjs"],
  default: [".js", ".cjs", ".mjs"],
});

/** @returns {boolean} true for non-null, non-array objects. */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Quote a subpath the way `package.json` writes it, for message labels. */
const quoted = (subpath) => JSON.stringify(subpath);

/** Flatten a (possibly nested) conditional-exports object into leaf targets.
 *
 * Node allows nesting such as `{ require: { types, default } }`; we record the
 * full condition path so error messages stay unambiguous.
 */
function flattenConditions(subpath, value, prefix, leaves, errors) {
  for (const [condition, target] of Object.entries(value)) {
    const conditions = [...prefix, condition];
    if (typeof target === "string") {
      leaves.push({ conditions, target });
    } else if (isPlainObject(target)) {
      flattenConditions(subpath, target, conditions, leaves, errors);
    } else if (Array.isArray(target)) {
      errors.push(
        `exports[${quoted(subpath)}] target for "${conditions.join(".")}" is an array; ` +
          "this package declares explicit string conditions only",
      );
    } else {
      errors.push(
        `exports[${quoted(subpath)}] target for "${conditions.join(".")}" must be a string, got ` +
          `${target === null ? "null" : typeof target}`,
      );
    }
  }
}

/** Validate a single target path against the rules for its leaf condition. */
function validateTargetPath(subpath, conditions, target) {
  const label = `exports[${quoted(subpath)}].${conditions.join(".")}`;

  if (target.includes("\0")) {
    return `${label} must not contain NUL bytes`;
  }
  if (target.split("/").some((segment) => segment === "..")) {
    return `${label} must not escape the package root (got "${target}")`;
  }
  if (!target.startsWith("./")) {
    return `${label} must be a relative path starting with "./" (got "${target}")`;
  }

  const allowed = ALLOWED_EXTENSIONS[conditions[conditions.length - 1]];
  if (allowed && !allowed.some((ext) => target.endsWith(ext))) {
    return `${label} must end with one of ${allowed.join(", ")} (got "${target}")`;
  }
  return null;
}

/**
 * Check that a `files` allow-list entry makes `target` part of the tarball.
 * `files: ["dist"]` covers `./dist/esm/index.js`; `files: ["dist/esm"]` does
 * not. Anything outside every entry would be missing from the published
 * package even though the export map points at it.
 */
export function isTargetCoveredByFiles(target, files) {
  const clean = target.replace(/^\.\//, "");
  return files.some((entry) => {
    if (typeof entry !== "string") return false;
    const dir = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    if (dir === "") return false;
    return clean === dir || clean.startsWith(`${dir}/`);
  });
}

/**
 * The target a condition actually resolves to. For nested objects such as
 * `{ require: { types, default } }` the later condition is the runtime one, so
 * scan from the end rather than returning the first (type-only) leaf.
 */
function runtimeTargetForCondition(leaves, condition) {
  for (let i = leaves.length - 1; i >= 0; i -= 1) {
    if (leaves[i].conditions[0] === condition) return leaves[i].target;
  }
  return undefined;
}

/**
 * Validate one entry of the export map (the root barrel or a subpath).
 *
 * @param {string} subpath package-relative subpath key, e.g. "." or "./webhooks"
 * @param {unknown} spec the value declared for that subpath
 * @param {string[]} files the package `files` allow-list
 */
function validateEntry(subpath, spec, files) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(spec)) {
    return {
      subpath,
      ok: false,
      errors: [
        `exports[${quoted(subpath)}] must be a conditional object, got ` +
          `${spec === null ? "null" : typeof spec} ` +
          "(a single string cannot describe both the CJS and ESM entry points)",
      ],
      warnings,
      targets: [],
    };
  }

  const leaves = [];
  flattenConditions(subpath, spec, [], leaves, errors);

  const topLevel = Object.keys(spec);
  const hasCondition = (name) =>
    topLevel.includes(name) || leaves.some((leaf) => leaf.conditions[0] === name);
  for (const condition of REQUIRED_CONDITIONS) {
    if (!hasCondition(condition)) {
      errors.push(`exports[${quoted(subpath)}] is missing the required "${condition}" condition`);
    }
  }

  for (const leaf of leaves) {
    const error = validateTargetPath(subpath, leaf.conditions, leaf.target);
    if (error) errors.push(error);
  }

  const importTarget = runtimeTargetForCondition(leaves, "import");
  const requireTarget = runtimeTargetForCondition(leaves, "require");
  if (importTarget && requireTarget && importTarget === requireTarget) {
    errors.push(
      `exports[${quoted(subpath)}] must resolve "import" (ESM) and "require" (CJS) to ` +
        "different files so each consumer gets the right module format",
    );
  }

  for (const leaf of leaves) {
    if (leaf.conditions[0] === "types") continue;
    if (!isTargetCoveredByFiles(leaf.target, files)) {
      errors.push(
        `export target "${leaf.target}" is not covered by the published "files" list`,
      );
    }
  }

  for (const condition of topLevel) {
    if (!REQUIRED_CONDITIONS.includes(condition) && !OPTIONAL_CONDITIONS.includes(condition)) {
      warnings.push(
        `unrecognised export condition "${condition}" on exports[${quoted(subpath)}] ` +
          "— confirm it is intentional",
      );
    }
  }
  if (
    topLevel.includes("browser") &&
    topLevel.includes("import") &&
    topLevel.indexOf("browser") > topLevel.indexOf("import")
  ) {
    warnings.push(
      `"browser" is declared after "import"/"require" on exports[${quoted(subpath)}], so ` +
        "Node and condition-order-sensitive bundlers will never select it",
    );
  }
  if (topLevel.includes("types") && topLevel[0] !== "types") {
    warnings.push(
      `"types" is not the first condition on exports[${quoted(subpath)}]; ` +
        "TypeScript tooling recommends listing it first",
    );
  }

  return {
    subpath,
    ok: errors.length === 0,
    errors,
    warnings,
    targets: leaves.map((leaf) => ({
      condition: leaf.conditions.join("."),
      target: leaf.target,
    })),
  };
}

/**
 * Validate every entry of a `package.json` export map.
 *
 * The result keeps its original shape for the root subpath (`targets` lists the
 * root's leaves) and adds `subpaths` with the per-entry breakdown so callers can
 * resolve each entry on disk separately.
 *
 * @param {unknown} pkg parsed package.json object
 * @returns {{ ok: boolean, errors: string[], warnings: string[],
 *            targets: Array<{ condition: string, target: string }>,
 *            subpaths: Array<{ subpath: string, ok: boolean, errors: string[],
 *                              warnings: string[],
 *                              targets: Array<{ condition: string, target: string }> }> }}
 */
export function validateExportMap(pkg) {
  const empty = { ok: false, errors: [], warnings: [], targets: [], subpaths: [] };

  if (!isPlainObject(pkg)) {
    return { ...empty, errors: ["package.json must be a JSON object"] };
  }
  if (!isPlainObject(pkg.exports)) {
    return { ...empty, errors: ['package.json must declare an "exports" object'] };
  }

  const root = pkg.exports[ROOT_SUBPATH];
  if (root === undefined) {
    return {
      ...empty,
      errors: ['exports must declare the "." subpath used by "@talos-protocol/sdk"'],
    };
  }

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const subpaths = [validateEntry(ROOT_SUBPATH, root, files)];
  for (const subpath of Object.keys(pkg.exports)) {
    if (subpath === ROOT_SUBPATH) continue;
    subpaths.push(validateEntry(subpath, pkg.exports[subpath], files));
  }

  if (typeof pkg.main === "string") {
    const main = pkg.main.replace(/^\.\//, "");
    const rootTargets = subpaths[0].targets;
    if (!rootTargets.some((leaf) => leaf.target.replace(/^\.\//, "") === main)) {
      subpaths[0].warnings.push(
        `"main" (${pkg.main}) does not match any declared export target`,
      );
    }
  }

  return {
    ok: subpaths.every((entry) => entry.ok),
    errors: subpaths.flatMap((entry) => entry.errors),
    warnings: subpaths.flatMap((entry) => entry.warnings),
    targets: subpaths[0].targets,
    subpaths,
  };
}
