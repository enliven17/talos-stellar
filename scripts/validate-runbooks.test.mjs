import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkRequiredSections,
  extractReferencedRepoFiles,
  checkReferencedFiles,
  checkReferencedCommands,
  discoverRunbooks,
  validateRunbookFile,
} from "./validate-runbooks.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "validate-runbooks.mjs");
const REAL_RUNBOOK = join(REPO_ROOT, "docs", "DR_RUNBOOK.md");

function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "runbook-validate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_RUNBOOK = `# Example Runbook

## Operational triggers

Alert fires when X happens.

## Verification

Run \`node scripts/check.mjs\` to confirm.

## Restore procedures

Steps to restore.

## Troubleshooting

Known issues.
`;

// ── Regression: the real repo runbook must pass every check ──────────────

test("real docs/DR_RUNBOOK.md has all required sections", () => {
  const content = readFileSync(REAL_RUNBOOK, "utf8");
  assert.deepEqual(checkRequiredSections(content), []);
});

test("real docs/DR_RUNBOOK.md only references files that exist", () => {
  const content = readFileSync(REAL_RUNBOOK, "utf8");
  assert.deepEqual(checkReferencedFiles(content, REPO_ROOT, join(REPO_ROOT, "docs")), []);
});

test("real docs/DR_RUNBOOK.md only references commands that exist", () => {
  const content = readFileSync(REAL_RUNBOOK, "utf8");
  assert.deepEqual(checkReferencedCommands(content, REPO_ROOT), []);
});

test("discoverRunbooks finds the real DR runbook", () => {
  const files = discoverRunbooks(REPO_ROOT);
  assert.ok(files.includes(REAL_RUNBOOK), `expected ${REAL_RUNBOOK} in ${JSON.stringify(files)}`);
});

test("validateRunbookFile reports no errors for the real DR runbook", () => {
  assert.deepEqual(validateRunbookFile(REAL_RUNBOOK, REPO_ROOT), []);
});

// ── checkRequiredSections ──────────────────────────────────────────────────

test("checkRequiredSections passes a runbook covering all groups", () => {
  assert.deepEqual(checkRequiredSections(VALID_RUNBOOK), []);
});

test("checkRequiredSections flags every missing group", () => {
  const missing = checkRequiredSections("# Title\n\nJust prose, no headings that match.\n");
  assert.deepEqual(missing.sort(), ["recovery/rollback", "trigger/detection", "troubleshooting", "verification"].sort());
});

test("checkRequiredSections accepts synonym headings", () => {
  const doc = "# Doc\n## Alerting\n## Diagnosis\n## Rollback plan\n## Known issues\n";
  assert.deepEqual(checkRequiredSections(doc), []);
});

// ── extractReferencedRepoFiles / checkReferencedFiles ──────────────────────

test("extractReferencedRepoFiles picks up markdown links and repo-path code spans", () => {
  const doc = "See [guide](./docs/DR_RUNBOOK.md) and `web/src/lib/backup-crypto.ts`. Also `/tmp/restore.enc`.";
  const { linkRefs, codeRefs } = extractReferencedRepoFiles(doc);
  assert.ok(linkRefs.includes("./docs/DR_RUNBOOK.md"));
  assert.ok(codeRefs.includes("web/src/lib/backup-crypto.ts"));
  assert.ok(!codeRefs.includes("/tmp/restore.enc"), "runtime-looking paths must not be treated as repo files");
});

test("extractReferencedRepoFiles ignores http and mailto links", () => {
  const doc = "[site](https://example.com) [mail](mailto:a@b.com)";
  assert.deepEqual(extractReferencedRepoFiles(doc), { linkRefs: [], codeRefs: [] });
});

test("checkReferencedFiles flags a missing linked file, resolved relative to the runbook's own directory", () => {
  withTempRepo((repoRoot) => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    const errors = checkReferencedFiles("[nope](./DOES_NOT_EXIST.md)", repoRoot, join(repoRoot, "docs"));
    assert.ok(errors.some((e) => e.includes("DOES_NOT_EXIST.md")));
  });
});

test("checkReferencedFiles resolves a parent-relative link against the runbook's directory", () => {
  withTempRepo((repoRoot) => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    mkdirSync(join(repoRoot, "scripts"), { recursive: true });
    writeFileSync(join(repoRoot, "scripts", "validate-runbooks.mjs"), "// stub");
    const errors = checkReferencedFiles(
      "[validator](../scripts/validate-runbooks.mjs)",
      repoRoot,
      join(repoRoot, "docs"),
    );
    assert.deepEqual(errors, []);
  });
});

// ── checkReferencedCommands ─────────────────────────────────────────────────

function setupFakeRepo(repoRoot) {
  mkdirSync(join(repoRoot, "web"), { recursive: true });
  writeFileSync(join(repoRoot, "web", "package.json"), JSON.stringify({ name: "web", scripts: { "db:migrate": "x" } }));
  mkdirSync(join(repoRoot, "packages", "prime-agent"), { recursive: true });
  writeFileSync(join(repoRoot, "packages", "prime-agent", "pyproject.toml"), "[project.scripts]\ntalos-agent = \"talos_agent.cli:main\"\n");
}

test("checkReferencedCommands accepts a real pnpm --dir script", () => {
  withTempRepo((repoRoot) => {
    setupFakeRepo(repoRoot);
    const doc = "```bash\npnpm --dir web run db:migrate\n```\n";
    assert.deepEqual(checkReferencedCommands(doc, repoRoot), []);
  });
});

test("checkReferencedCommands flags a bogus pnpm --dir script", () => {
  withTempRepo((repoRoot) => {
    setupFakeRepo(repoRoot);
    const doc = "```bash\npnpm --dir web run totally-bogus-script\n```\n";
    const errors = checkReferencedCommands(doc, repoRoot);
    assert.ok(errors.some((e) => e.includes("totally-bogus-script")));
  });
});

test("checkReferencedCommands accepts a real uv run binary", () => {
  withTempRepo((repoRoot) => {
    setupFakeRepo(repoRoot);
    const doc = "```bash\nuv run talos-agent backup-doctor\n```\n";
    assert.deepEqual(checkReferencedCommands(doc, repoRoot), []);
  });
});

test("checkReferencedCommands flags an unknown uv run binary", () => {
  withTempRepo((repoRoot) => {
    setupFakeRepo(repoRoot);
    const doc = "```bash\nuv run nonexistent-cli status\n```\n";
    const errors = checkReferencedCommands(doc, repoRoot);
    assert.ok(errors.some((e) => e.includes("nonexistent-cli")));
  });
});

test("checkReferencedCommands ignores commands outside fenced code blocks", () => {
  withTempRepo((repoRoot) => {
    setupFakeRepo(repoRoot);
    const doc = "Just prose mentioning pnpm --dir web run whatever-you-like, not fenced.";
    assert.deepEqual(checkReferencedCommands(doc, repoRoot), []);
  });
});

// ── discoverRunbooks ────────────────────────────────────────────────────────

test("discoverRunbooks returns an empty list when nothing matches", () => {
  withTempRepo((repoRoot) => {
    assert.deepEqual(discoverRunbooks(repoRoot), []);
  });
});

test("discoverRunbooks matches files in docs/ and at the repo root", () => {
  withTempRepo((repoRoot) => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "API_RUNBOOK.md"), VALID_RUNBOOK);
    writeFileSync(join(repoRoot, "INCIDENT_RUNBOOK.md"), VALID_RUNBOOK);
    const files = discoverRunbooks(repoRoot).sort();
    assert.equal(files.length, 2);
  });
});

// ── CLI end to end ──────────────────────────────────────────────────────────

test("CLI exits 0 for the real repo", () => {
  const out = execFileSync(process.execPath, [SCRIPT_PATH, REPO_ROOT], { encoding: "utf8" });
  assert.match(out, /OK: validated/);
});

test("CLI fails closed (exit 1) when no runbooks are found", () => {
  withTempRepo((repoRoot) => {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH, repoRoot], { stdio: "pipe" }));
  });
});

test("CLI exits 1 when a runbook references a missing file", () => {
  withTempRepo((repoRoot) => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "BAD_RUNBOOK.md"), VALID_RUNBOOK + "\nSee `docs/NOPE.md`.\n");
    assert.throws(() => execFileSync(process.execPath, [SCRIPT_PATH, repoRoot], { stdio: "pipe" }));
  });
});
