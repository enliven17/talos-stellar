#!/usr/bin/env node
// validate-runbooks.mjs, validates incident/DR runbook docs.
//
// Discovers runbook files (any *RUNBOOK*.md at the repo root or directly
// under docs/), then checks each one for:
//   1. Required section headings (trigger/detection, verification,
//      recovery/rollback, troubleshooting), by keyword, so a runbook can
//      use its own wording (e.g. "Restore procedures" satisfies recovery).
//   2. Referenced repo files actually exist, Markdown links, plus inline
//      code spans that look like repo-relative paths (web/, packages/,
//      contracts/, scripts/, docs/, or an ALL-CAPS root doc like
//      MIGRATIONS.md).
//   3. Referenced commands actually exist, `pnpm --dir <x> run <script>`,
//      `pnpm --filter <name> run <script>` (checked against the matching
//      package.json "scripts"), and `uv run <bin>` (checked against
//      packages/prime-agent/pyproject.toml's [project.scripts]).
//
// This only checks references that are unambiguous by construction (a
// Markdown link target, a path-shaped code span, a recognized command
// shape). Runtime example paths (/tmp/..., ~/.talos-agent/...) are out of
// scope and never flagged. Anything that IS in scope but does not resolve
// is a hard error, no warnings, nothing is skipped as "probably fine"
// (fail closed on ambiguous input, including "no runbooks found" at all).
//
// Usage:
//   node scripts/validate-runbooks.mjs [repoRoot]   # default: cwd
//
// Exit codes:
//   0, all discovered runbooks pass
//   1, a runbook is missing a section, or a referenced file/command is
//       missing, or no runbook files were found at all

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Required sections ─────────────────────────────────────────────────────

const REQUIRED_SECTION_GROUPS = [
  { name: "trigger/detection", keywords: ["trigger", "detect", "alert", "symptom"] },
  { name: "verification", keywords: ["verif", "diagnos"] },
  { name: "recovery/rollback", keywords: ["restore", "recovery", "rollback", "remediat"] },
  { name: "troubleshooting", keywords: ["troubleshoot", "known issue", "faq"] },
];

export function extractHeadings(content) {
  return content
    .split(/\r?\n/)
    .filter((l) => /^#{1,6}\s+/.test(l))
    .map((l) => l.replace(/^#{1,6}\s+/, "").trim());
}

export function checkRequiredSections(content) {
  const headings = extractHeadings(content).map((h) => h.toLowerCase());
  return REQUIRED_SECTION_GROUPS.filter(
    (group) => !headings.some((h) => group.keywords.some((k) => h.includes(k))),
  ).map((group) => group.name);
}

// ── Referenced files ───────────────────────────────────────────────────────

const REPO_PATH_PREFIXES = ["web/", "packages/", "contracts/", "scripts/", "docs/"];

function extractFencedBlocks(content) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content))) blocks.push(m[1]);
  return blocks;
}

// Markdown link targets are resolved relative to the runbook's own
// directory (standard Markdown semantics). Inline-code repo-path spans are
// always written relative to the repo root by convention in this repo, so
// they resolve against repoRoot instead.
export function extractReferencedRepoFiles(content) {
  const linkRefs = new Set();
  const codeRefs = new Set();
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = linkRe.exec(content))) {
    const target = m[1].split("#")[0];
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // scheme (http:, mailto:, ...)
    linkRefs.add(target);
  }
  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(content))) {
    const target = m[1];
    if (REPO_PATH_PREFIXES.some((p) => target.startsWith(p)) || /^[A-Z][A-Z0-9_]*\.md$/.test(target)) {
      codeRefs.add(target);
    }
  }
  return { linkRefs: [...linkRefs], codeRefs: [...codeRefs] };
}

export function checkReferencedFiles(content, repoRoot, fileDir = repoRoot) {
  const { linkRefs, codeRefs } = extractReferencedRepoFiles(content);
  const errors = [];
  for (const ref of linkRefs) {
    if (!existsSync(join(fileDir, ref))) errors.push(`referenced file "${ref}" does not exist`);
  }
  for (const ref of codeRefs) {
    if (!existsSync(join(repoRoot, ref))) errors.push(`referenced file "${ref}" does not exist`);
  }
  return errors;
}

// ── Referenced commands ──────────────────────────────────────────────────

function readPackageScripts(pkgJsonPath) {
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return { name: pkg.name, scripts: pkg.scripts ?? {} };
  } catch {
    return null;
  }
}

function findWorkspacePackageByName(repoRoot, name) {
  const candidates = [join(repoRoot, "package.json"), join(repoRoot, "web", "package.json")];
  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      candidates.push(join(packagesDir, entry, "package.json"));
    }
  }
  for (const c of candidates) {
    const pkg = readPackageScripts(c);
    if (pkg && pkg.name === name) return pkg;
  }
  return null;
}

export function checkReferencedCommands(content, repoRoot) {
  const errors = [];
  for (const block of extractFencedBlocks(content)) {
    for (const m of block.matchAll(/pnpm\s+--dir\s+(\S+)\s+run\s+(\S+)/g)) {
      const [, dir, script] = m;
      const pkg = readPackageScripts(join(repoRoot, dir, "package.json"));
      if (!pkg) {
        errors.push(`referenced "pnpm --dir ${dir} run ${script}" but ${dir}/package.json does not exist`);
      } else if (!(script in pkg.scripts)) {
        errors.push(`referenced script "${script}" not found in ${dir}/package.json`);
      }
    }
    for (const m of block.matchAll(/pnpm\s+--filter\s+(\S+)\s+run\s+(\S+)/g)) {
      const [, name, script] = m;
      const pkg = findWorkspacePackageByName(repoRoot, name);
      if (!pkg) {
        errors.push(`referenced "pnpm --filter ${name}" but no workspace package is named "${name}"`);
      } else if (!(script in pkg.scripts)) {
        errors.push(`referenced script "${script}" not found in package "${name}"`);
      }
    }
    for (const m of block.matchAll(/\buv run ([a-zA-Z0-9_-]+)\b/g)) {
      const bin = m[1];
      const pyproject = join(repoRoot, "packages", "prime-agent", "pyproject.toml");
      if (!existsSync(pyproject)) {
        errors.push(`referenced "uv run ${bin}" but packages/prime-agent/pyproject.toml does not exist`);
        continue;
      }
      const text = readFileSync(pyproject, "utf8");
      if (!new RegExp(`^${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m").test(text)) {
        errors.push(`referenced "uv run ${bin}" but no matching [project.scripts] entry in packages/prime-agent/pyproject.toml`);
      }
    }
  }
  return errors;
}

// ── Discovery + top-level validation ─────────────────────────────────────

export function discoverRunbooks(repoRoot) {
  const found = [];
  const scanDir = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md") && /runbook/i.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  scanDir(repoRoot);
  scanDir(join(repoRoot, "docs"));
  return found;
}

export function validateRunbookFile(filePath, repoRoot) {
  const content = readFileSync(filePath, "utf8");
  const errors = [];
  for (const section of checkRequiredSections(content)) {
    errors.push(`missing required section: ${section}`);
  }
  errors.push(...checkReferencedFiles(content, repoRoot, dirname(filePath)));
  errors.push(...checkReferencedCommands(content, repoRoot));
  return errors;
}

export function validateAllRunbooks(repoRoot) {
  const files = discoverRunbooks(repoRoot);
  const results = {};
  for (const f of files) results[f] = validateRunbookFile(f, repoRoot);
  return { files, results };
}

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const { files, results } = validateAllRunbooks(repoRoot);
  if (files.length === 0) {
    console.error(
      `No runbook files found under ${repoRoot} (expected e.g. docs/*RUNBOOK*.md). Failing closed: ` +
        `either add one or point this command at the right repo root.`,
    );
    process.exitCode = 1;
    return;
  }
  let hasErrors = false;
  for (const f of files) {
    const errs = results[f];
    if (errs.length > 0) {
      hasErrors = true;
      console.error(`${f}:`);
      for (const e of errs) console.error(`  - ${e}`);
    }
  }
  if (hasErrors) {
    process.exitCode = 1;
  } else {
    console.log(`OK: validated ${files.length} runbook(s):\n  ${files.join("\n  ")}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
