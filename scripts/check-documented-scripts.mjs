#!/usr/bin/env node

/**
 * Check that npm and pnpm commands documented in Markdown exist in the
 * relevant package.json. The checker only reads local files; it never
 * contacts a package registry or executes documented commands.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_PACKAGE = "package.json";
const OPTIONAL_PACKAGES = ["web/package.json", "contracts/package.json"];
const DOC_FILES = ["README.md", "CONTRIBUTING.md"];

const PNPM_BUILTINS = new Set([
  "add",
  "audit",
  "bin",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dir",
  "dlx",
  "env",
  "exec",
  "fetch",
  "filter",
  "help",
  "i",
  "import",
  "init",
  "install",
  "install-test",
  "it",
  "licenses",
  "link",
  "list",
  "ln",
  "ls",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "patch-remove",
  "prune",
  "publish",
  "rebuild",
  "recursive",
  "remove",
  "rm",
  "root",
  "server",
  "setup",
  "store",
  "uninstall",
  "unlink",
  "up",
  "update",
  "upgrade",
  "version",
  "why",
  "workspace",
]);

const NPM_BUILTINS = new Set([
  "add",
  "audit",
  "cache",
  "ci",
  "config",
  "dedupe",
  "doctor",
  "exec",
  "explain",
  "fund",
  "help",
  "i",
  "info",
  "init",
  "install",
  "install-test",
  "link",
  "login",
  "logout",
  "ls",
  "outdated",
  "owner",
  "pack",
  "ping",
  "prefix",
  "prune",
  "publish",
  "query",
  "rebuild",
  "repo",
  "root",
  "search",
  "shrinkwrap",
  "star",
  "team",
  "uninstall",
  "unlink",
  "unpublish",
  "update",
  "version",
  "view",
  "whoami",
]);

const PLACEHOLDER = /[<>${}*]|\.\.\./;
const SCRIPT_LIKE = /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/;

function isPlaceholder(value) {
  return !value || PLACEHOLDER.test(value);
}

function isScriptName(value) {
  return (
    !isPlaceholder(value) &&
    SCRIPT_LIKE.test(value) &&
    !/^v?\d+(?:\.\d+)*$/.test(value)
  );
}

function splitSegments(line) {
  return line.split(/\s*(?:&&|;)\s*/).filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < segment.length) {
        current += segment[++index];
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else if (char === "\\" && index + 1 < segment.length) {
      current += segment[++index];
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

function cleanDocumentedLine(text) {
  return text
    .replace(/^\s*\$+\s+/, "")
    .replace(/\s+#.*$/, "")
    .trim();
}

/**
 * Parse one shell line. Returns the updated working directory and every
 * npm/pnpm script invocation found in it.
 */
export function parseInvocationLine(line, { cwd, rootDir }) {
  let nextCwd = cwd;
  const invocations = [];

  for (const segment of splitSegments(cleanDocumentedLine(line))) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    if (tokens[0] === "cd") {
      if (tokens[1] && !PLACEHOLDER.test(tokens[1])) {
        nextCwd = path.resolve(nextCwd, tokens[1]);
      }
      continue;
    }

    const invocation = parseInvocation(tokens, { cwd: nextCwd, rootDir });
    if (invocation) invocations.push(invocation);
  }

  return { cwd: nextCwd, invocations };
}

function parseInvocation(tokens, { cwd, rootDir }) {
  const manager = tokens[0];
  if (manager !== "npm" && manager !== "pnpm") return null;

  let index = 1;
  let dir = cwd;
  let filter;
  let explicitDir = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--dir" || token === "-C" || token === "--prefix") {
      const value = tokens[index + 1];
      if (isPlaceholder(value)) return null;
      dir = path.resolve(cwd, value);
      explicitDir = true;
      index += 2;
    } else if (token.startsWith("--dir=") || token.startsWith("--prefix=")) {
      const value = token.split("=").slice(1).join("=");
      if (isPlaceholder(value)) return null;
      dir = path.resolve(cwd, value);
      explicitDir = true;
      index += 1;
    } else if (token === "--filter" || token === "-F") {
      const value = tokens[index + 1];
      if (isPlaceholder(value)) return null;
      filter = value;
      index += 2;
    } else if (token.startsWith("--filter=")) {
      const value = token.split("=").slice(1).join("=");
      if (isPlaceholder(value)) return null;
      filter = value;
      index += 1;
    } else if (token === "--workspace-root" || token === "-w") {
      dir = rootDir;
      explicitDir = true;
      index += 1;
    } else if (token.startsWith("-")) {
      index += 1;
    } else {
      break;
    }
  }

  const subcommand = tokens[index];
  if (!subcommand) return null;
  index += 1;

  let script;
  if (subcommand === "run" || subcommand === "run-script") {
    while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
    script = tokens[index];
  } else if (subcommand === "test" || subcommand === "t" || subcommand === "start" || subcommand === "stop" || subcommand === "restart") {
    script = subcommand;
  } else if (manager === "pnpm") {
    if (PNPM_BUILTINS.has(subcommand)) return null;
    script = subcommand;
  } else {
    if (NPM_BUILTINS.has(subcommand)) return null;
    return null;
  }

  if (!isScriptName(script)) return null;
  return { manager, dir, explicitDir, filter, script, command: tokens.join(" ") };
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function loadPackages(rootDir) {
  const relativePaths = [ROOT_PACKAGE, ...OPTIONAL_PACKAGES];
  try {
    const entries = await readdir(path.join(rootDir, "packages"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) relativePaths.push(`packages/${entry.name}/package.json`);
    }
  } catch {
    // No packages directory is fine.
  }

  const packages = [];
  for (const relativePath of relativePaths) {
    let parsed;
    try {
      parsed = await readJson(path.join(rootDir, relativePath), relativePath);
    } catch (error) {
      if (relativePath === ROOT_PACKAGE || !error.message.includes("ENOENT")) throw error;
      continue;
    }
    packages.push({
      relativePath,
      dir: path.dirname(relativePath) === "." ? "." : path.dirname(relativePath),
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      scripts: parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {},
    });
  }

  return {
    all: packages,
    byDir: new Map(packages.map((pkg) => [pkg.dir, pkg])),
    byName: new Map(packages.filter((pkg) => pkg.name).map((pkg) => [pkg.name, pkg])),
    byBaseName: new Map(
      packages
        .filter((pkg) => pkg.dir !== ".")
        .map((pkg) => [path.basename(pkg.dir), pkg]),
    ),
  };
}

function resolvePackage({ dir, explicitDir, filter, script, rootDir, packages }) {
  if (filter) {
    const pkg = packages.byName.get(filter) ?? packages.byBaseName.get(filter);
    return pkg ? { pkg } : { error: `no workspace package named "${filter}"` };
  }

  const relative = path.relative(rootDir, dir) || ".";
  const normalized = relative.split(path.sep).join("/");
  const pkg = packages.byDir.get(normalized === "" ? "." : normalized);
  if (!pkg) return null;

  if (typeof pkg.scripts[script] === "string") return { pkg };

  // Documentation often lists workspace commands after a prose `cd` or under a
  // workspace heading. When a bare command is not in the root package but
  // exactly one workspace provides it, accept that unambiguous match.
  if (!explicitDir && normalized === ".") {
    const matches = packages.all.filter(
      (candidate) => typeof candidate.scripts[script] === "string",
    );
    if (matches.length === 1) return { pkg: matches[0], uniqueMatch: true };
  }

  return { pkg };
}

async function collectDocFiles(rootDir) {
  const files = [];
  for (const name of DOC_FILES) {
    try {
      await readFile(path.join(rootDir, name), "utf8");
      files.push(name);
    } catch {
      // Missing optional root docs are fine.
    }
  }

  async function walk(relativeDir) {
    let entries;
    try {
      entries = await readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await walk(relativePath);
      else if (entry.name.endsWith(".md")) files.push(relativePath);
    }
  }

  await walk("docs");
  return files;
}

/**
 * Extract fenced code blocks and inline code spans from Markdown. Fenced
 * blocks keep a block id so shell `cd` state can be tracked per example.
 */
export function extractCodeSegments(markdown) {
  const segments = [];
  const lines = markdown.split("\n");
  let fence;
  let blockId = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);

    if (fenceMatch) {
      if (!fence) {
        fence = fenceMatch[1][0];
        blockId += 1;
      } else if (fenceMatch[1][0] === fence) {
        fence = undefined;
      }
      continue;
    }

    if (fence) {
      segments.push({ line: index + 1, text: line, lineText: line, blockId });
      continue;
    }

    const inline = line.match(/`([^`\n]+)`/g) ?? [];
    for (const span of inline) {
      segments.push({
        line: index + 1,
        text: span.slice(1, -1),
        lineText: line,
        blockId: undefined,
      });
    }
  }

  return segments;
}

function inferWorkspaceDir(lineText, rootDir, packages) {
  const normalized = lineText.replace(/\\/g, "/");
  for (const pkg of packages.all) {
    if (pkg.dir !== "." && normalized.includes(pkg.dir)) {
      return path.join(rootDir, pkg.dir);
    }
  }
  return undefined;
}

/**
 * Check every documented npm/pnpm script against its package.json.
 * Throws when a package.json is missing or malformed (fail closed).
 */
export async function checkDocumentedScripts({ rootDir = process.cwd() } = {}) {
  const packages = await loadPackages(rootDir);
  const docFiles = await collectDocFiles(rootDir);
  if (docFiles.length === 0) {
    throw new Error("no Markdown documentation files found");
  }

  const entries = [];
  for (const relativePath of docFiles) {
    const markdown = await readFile(path.join(rootDir, relativePath), "utf8");
    const blockCwd = new Map();

    for (const segment of extractCodeSegments(markdown)) {
      const hint =
        segment.blockId === undefined
          ? inferWorkspaceDir(segment.lineText, rootDir, packages)
          : undefined;
      const cwd =
        segment.blockId === undefined
          ? rootDir
          : blockCwd.get(segment.blockId) ?? rootDir;

      const { cwd: nextCwd, invocations } = parseInvocationLine(segment.text, {
        cwd,
        rootDir,
      });
      if (segment.blockId !== undefined) blockCwd.set(segment.blockId, nextCwd);

      for (const invocation of invocations) {
        let resolved = resolvePackage({ ...invocation, rootDir, packages });
        if (!resolved) continue;

        if (
          hint &&
          !resolved.error &&
          typeof resolved.pkg.scripts[invocation.script] !== "string"
        ) {
          const relativeHint = path
            .relative(rootDir, hint)
            .split(path.sep)
            .join("/");
          const hintPackage = packages.byDir.get(relativeHint);
          if (hintPackage && typeof hintPackage.scripts[invocation.script] === "string") {
            resolved = { pkg: hintPackage, inferredFromText: true };
          }
        }

        if (resolved.error) {
          entries.push({
            file: relativePath,
            line: segment.line,
            command: invocation.command,
            workspace: invocation.filter,
            script: invocation.script,
            ok: false,
            reason: resolved.error,
          });
          continue;
        }

        const { pkg } = resolved;
        const exists = typeof pkg.scripts[invocation.script] === "string";
        entries.push({
          file: relativePath,
          line: segment.line,
          command: invocation.command,
          workspace: pkg.relativePath,
          script: invocation.script,
          ok: exists,
          note: resolved.uniqueMatch
            ? "unique workspace match"
            : resolved.inferredFromText
              ? "workspace inferred from surrounding text"
              : undefined,
          reason: exists
            ? undefined
            : `${pkg.relativePath} has no "${invocation.script}" script`,
        });
      }
    }
  }

  entries.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.command.localeCompare(right.command),
  );

  return {
    checked: entries.length,
    missing: entries.filter((entry) => !entry.ok),
    entries,
  };
}

export function formatReport({ checked, missing, entries }, { verbose = false } = {}) {
  const lines = [`Documented scripts checked: ${checked}`];

  if (verbose) {
    for (const entry of entries) {
      lines.push(
        `${entry.ok ? "ok  " : "MISS"} ${entry.file}:${entry.line}  ${entry.command}` +
          (entry.ok
            ? ` -> ${entry.workspace}:${entry.script}` +
              (entry.note ? ` (${entry.note})` : "")
            : `  (${entry.reason})`),
      );
    }
  }

  for (const entry of missing) {
    if (!verbose) {
      lines.push(`MISSING ${entry.file}:${entry.line}  ${entry.command}  (${entry.reason})`);
    }
  }

  lines.push(
    missing.length === 0
      ? "OK: every documented npm/pnpm script exists."
      : `FAILED: ${missing.length} documented script(s) missing.`,
  );
  return lines.join("\n");
}

const USAGE = `Usage: node scripts/check-documented-scripts.mjs [options]

Options:
  --verbose   Print every checked command.
  --json      Print machine-readable JSON.
  -h, --help  Show this help.

The checker reads README.md, CONTRIBUTING.md, and docs/**/*.md, then
verifies each documented npm/pnpm script against its local package.json.
It never contacts a package registry.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }

  try {
    const result = await checkDocumentedScripts();
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReport(result, { verbose: args.includes("--verbose") }));
    }
    if (result.missing.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
