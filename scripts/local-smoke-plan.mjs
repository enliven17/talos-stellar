#!/usr/bin/env node

/**
 * Deterministic local smoke plan generator.
 *
 * Reads changed file paths (from git or `--file`) and prints the exact
 * commands a contributor should run for the affected workspaces. It never
 * installs packages, reads environment files, uses credentials, or contacts
 * remote services.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WORKSPACES = ["web", "sdk", "prime-agent", "contracts"];

export const WORKSPACE_COMMANDS = {
  root: [
    "pnpm run doctor",
    "pnpm run lockfile:check",
  ],
  web: [
    "pnpm --dir web exec tsc --noEmit",
    "pnpm --dir web run lint",
    "pnpm --dir web run test:unit",
    "pnpm --dir web run test:payment-coverage",
    "pnpm --dir web run test:a11y",
  ],
  sdk: [
    "pnpm --dir packages/sdk run build",
    "pnpm --dir packages/sdk run test",
  ],
  "prime-agent": [
    "cd packages/prime-agent && uv run ruff check src tests scripts",
    "cd packages/prime-agent && uv run pytest tests/ -v --cov --cov-report=json --cov-report=term",
    "cd packages/prime-agent && uv run python scripts/check-coverage.py coverage.json",
  ],
  contracts: [
    "cd contracts && cargo test",
    "cd contracts && cargo build --target wasm32-unknown-unknown --release",
  ],
};

const ROOT_SHARED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "justfile",
  "compatibility.json",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".pre-commit-config.yaml",
]);

const ROOT_SHARED_PREFIXES = [".github/", ".devcontainer/", "scripts/"];
const DOC_PREFIXES = ["docs/"];
const DOC_FILE = /^(README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|CHANGELOG|LICENSE|NOTICE)(\.|$)/i;
const ENV_FILE = /(^|\/)\.env(\..*)?$/;

function normalizePath(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function classifyPath(file) {
  const normalized = normalizePath(file);
  if (!normalized) return "unknown";
  if (ENV_FILE.test(normalized)) return "environment";
  if (normalized.startsWith("web/")) return "web";
  if (normalized.startsWith("packages/sdk/")) return "sdk";
  if (normalized.startsWith("packages/prime-agent/")) return "prime-agent";
  if (normalized === "contracts/package.json") return "root";
  if (normalized.startsWith("contracts/")) return "contracts";
  if (ROOT_SHARED_FILES.has(normalized)) return "root";
  if (ROOT_SHARED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "root";
  if (DOC_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "docs";
  if (!normalized.includes("/") && DOC_FILE.test(normalized)) return "docs";
  return "unknown";
}

/**
 * Build a deterministic plan from a list of changed files.
 *
 * Unknown paths and shared root changes fail closed: every workspace is
 * planned. Documentation-only and environment-only changes need no workspace
 * commands. Environment files are classified by path only and never read.
 */
export function planLocalSmoke({ changedFiles = [], all = false } = {}) {
  const files = [...new Set(changedFiles.map(normalizePath))].filter(Boolean).sort();
  const unknownFiles = [];
  const selected = new Set();
  let hasDocs = false;
  let hasEnvironment = false;
  let hasActionable = false;

  for (const file of files) {
    const kind = classifyPath(file);
    if (kind === "docs") {
      hasDocs = true;
      continue;
    }
    if (kind === "environment") {
      hasEnvironment = true;
      continue;
    }

    hasActionable = true;

    if (kind === "unknown") {
      unknownFiles.push(file);
      selected.add("root");
      for (const workspace of WORKSPACES) selected.add(workspace);
    } else if (kind === "root") {
      selected.add("root");
      for (const workspace of WORKSPACES) selected.add(workspace);
    } else {
      selected.add(kind);
    }
  }

  if (all) {
    selected.add("root");
    for (const workspace of WORKSPACES) selected.add(workspace);
  }

  const ordered = ["root", ...WORKSPACES].filter((workspace) => selected.has(workspace));
  const commands = ordered.flatMap((workspace) =>
    WORKSPACE_COMMANDS[workspace].map((command) => ({ workspace, command })),
  );

  let status = "ok";
  if (all) status = "all";
  else if (files.length === 0) status = "no-changes";
  else if (!hasActionable && hasDocs && !hasEnvironment) status = "docs-only";
  else if (!hasActionable && hasEnvironment && !hasDocs) status = "environment-only";
  else if (!hasActionable) status = "non-code";
  else if (unknownFiles.length > 0) status = "unknown-paths";

  return {
    changedFiles: files,
    workspaces: ordered.filter((workspace) => workspace !== "root"),
    unknownFiles,
    status,
    commands,
    notes: [
      "This plan only prints commands. It does not install packages, read .env files, use credentials, or contact remote services.",
      "Unknown paths fail closed: every workspace is planned.",
      "Run the commands from the repository root.",
    ],
  };
}

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Collect changed paths from git. With a base revision this uses merge-base
 * semantics (`base...head`). Without one it compares the working tree and
 * untracked files against `head`.
 */
export function changedFilesFromGit({ base, head = "HEAD", cwd = process.cwd() } = {}) {
  if (base) {
    return runGit(["diff", "--name-only", `${base}...${head}`], cwd);
  }

  return [
    ...runGit(["diff", "--name-only", head], cwd),
    ...runGit(["ls-files", "--others", "--exclude-standard"], cwd),
  ];
}

export function formatPlan(plan) {
  const lines = ["Local smoke plan (deterministic, offline)", ""];

  if (plan.status === "no-changes") {
    lines.push("No changed files. Nothing to run.");
    return lines.join("\n");
  }

  if (plan.changedFiles.length > 0) {
    lines.push(`Changed files (${plan.changedFiles.length}):`);
    for (const file of plan.changedFiles) lines.push(`  - ${file}`);
    lines.push("");
  }

  if (plan.status === "all") {
    lines.push("Planning all workspaces (--all).");
    lines.push("");
  }

  if (plan.status === "docs-only") {
    lines.push("Documentation-only changes. No workspace checks required.");
  } else if (plan.status === "environment-only") {
    lines.push("Environment files changed. They are not read by this tool; review them manually.");
  } else if (plan.status === "non-code") {
    lines.push("Only documentation and environment files changed. No workspace checks required.");
  } else {
    lines.push(
      `Selected workspaces: ${plan.workspaces.length ? plan.workspaces.join(", ") : "none"}`,
    );
    lines.push("");
    lines.push("Commands (run from the repository root):");
    let currentWorkspace;
    for (const { workspace, command } of plan.commands) {
      if (workspace !== currentWorkspace) {
        lines.push(`  # ${workspace}`);
        currentWorkspace = workspace;
      }
      lines.push(`  ${command}`);
    }
  }

  if (plan.unknownFiles.length > 0) {
    lines.push("");
    lines.push(`Unclassified paths (${plan.unknownFiles.length}):`);
    for (const file of plan.unknownFiles) lines.push(`  - ${file}`);
  }

  lines.push("");
  lines.push("Notes:");
  for (const note of plan.notes) lines.push(`  - ${note}`);

  return lines.join("\n");
}

export function parseArgs(argv) {
  const options = { files: [], all: false, json: false, head: "HEAD", help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--base" || arg === "--head" || arg === "--file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--file") options.files.push(...value.split(","));
      else if (arg === "--base") options.base = value;
      else options.head = value;
    } else if (arg.startsWith("--base=") || arg.startsWith("--head=") || arg.startsWith("--file=")) {
      const [name, value] = arg.split("=", 2);
      if (!value) throw new Error(`${name} requires a value`);
      if (name === "--file") options.files.push(...value.split(","));
      else if (name === "--base") options.base = value;
      else options.head = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

const USAGE = `Usage: node scripts/local-smoke-plan.mjs [options]

Options:
  --base <rev>    Compare <rev>...HEAD instead of the working tree.
  --head <rev>    Head revision for --base comparisons (default: HEAD).
  --file <path>   Plan for an explicit path. Repeat or comma-separate.
  --all           Plan every workspace.
  --json          Print machine-readable JSON.
  -h, --help      Show this help.

Examples:
  node scripts/local-smoke-plan.mjs --base origin/main
  node scripts/local-smoke-plan.mjs --file web/src/app/page.tsx
  node scripts/local-smoke-plan.mjs --all --json`;

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }

    const changedFiles = options.files.length
      ? options.files
      : changedFilesFromGit({ base: options.base, head: options.head });
    const plan = planLocalSmoke({ changedFiles, all: options.all });

    console.log(options.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
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
