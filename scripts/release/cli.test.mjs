// Integration test: drives the real cli.mjs against a throwaway git repo
// scaffolded to mirror the actual monorepo layout (web/, packages/sdk/,
// packages/prime-agent/, contracts/*), exercising git + filesystem together
// instead of mocking them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" });
}

function runCli(repo, args) {
  return sh(repo, "node", [CLI, ...args]);
}

function runCliExpectFailure(repo, args) {
  try {
    runCli(repo, args);
    assert.fail("expected cli to exit with a non-zero status");
  } catch (err) {
    return err; // execFileSync throws with .status/.stdout/.stderr on non-zero exit
  }
}

function scaffoldRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "release-cli-"));
  process.env.RELEASE_CLI_REPO_ROOT = dir;

  sh(dir, "git", ["init", "-q"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "user.name", "Test"]);

  mkdirSync(path.join(dir, "web"), { recursive: true });
  writeFileSync(path.join(dir, "web/package.json"), JSON.stringify({ name: "web", version: "0.1.0" }, null, 2));

  mkdirSync(path.join(dir, "packages/sdk"), { recursive: true });
  writeFileSync(path.join(dir, "packages/sdk/package.json"), JSON.stringify({ name: "sdk", version: "0.1.0" }, null, 2));

  mkdirSync(path.join(dir, "packages/prime-agent"), { recursive: true });
  writeFileSync(path.join(dir, "packages/prime-agent/pyproject.toml"), '[project]\nname = "talos-agent"\nversion = "0.1.0"\n');

  for (const crate of ["talos_registry", "talos_name_service", "talos_governance"]) {
    mkdirSync(path.join(dir, "contracts", crate), { recursive: true });
    writeFileSync(path.join(dir, "contracts", crate, "Cargo.toml"), `[package]\nname = "${crate}"\nversion = "0.1.0"\n`);
  }

  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "chore: scaffold monorepo"]);

  return dir;
}

test("plan cuts a baseline release for every component on first run", () => {
  const repo = scaffoldRepo();
  try {
    const out = runCli(repo, ["plan"]);
    for (const name of ["web", "sdk", "agent", "contracts"]) {
      assert.match(out, new RegExp(`\\*\\*${name}\\*\\*: 0\\.1\\.0 -> 0\\.1\\.0 \\(baseline`));
    }
    assert.match(readFileSync(path.join(repo, "web/CHANGELOG.md"), "utf8"), /## web v0\.1\.0/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("tag --create tags every baselined component exactly once", () => {
  const repo = scaffoldRepo();
  try {
    runCli(repo, ["plan"]);
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "chore(release): cut baseline"]);

    const first = JSON.parse(runCli(repo, ["tag", "--create"]));
    assert.deepEqual(
      first.map((r) => r.tag).sort(),
      ["agent-v0.1.0", "contracts-v0.1.0", "sdk-v0.1.0", "web-v0.1.0"],
    );

    const tags = sh(repo, "git", ["tag", "--list"]).trim().split("\n").sort();
    assert.deepEqual(tags, ["agent-v0.1.0", "contracts-v0.1.0", "sdk-v0.1.0", "web-v0.1.0"]);

    // Idempotent: re-running with nothing new to release tags nothing again.
    const second = JSON.parse(runCli(repo, ["tag", "--create"]));
    assert.deepEqual(second, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plan only bumps the component whose path actually changed", () => {
  const repo = scaffoldRepo();
  try {
    runCli(repo, ["plan"]);
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "chore(release): cut baseline"]);
    runCli(repo, ["tag", "--create"]);

    writeFileSync(path.join(repo, "packages/sdk/README.md"), "docs\n");
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "feat(sdk): add payments resource"]);

    const out = runCli(repo, ["plan"]);
    assert.match(out, /\*\*sdk\*\*: 0\.1\.0 -> 0\.2\.0 \(minor, 1 commit\)/);
    assert.doesNotMatch(out, /\*\*web\*\*/);
    assert.doesNotMatch(out, /\*\*agent\*\*/);
    assert.doesNotMatch(out, /\*\*contracts\*\*/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plan skips a component whose only new commits are non-releasing", () => {
  const repo = scaffoldRepo();
  try {
    runCli(repo, ["plan"]);
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "chore(release): cut baseline"]);
    runCli(repo, ["tag", "--create"]);

    writeFileSync(path.join(repo, "web/README.md"), "docs\n");
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "docs(web): fix typo"]);

    const out = runCli(repo, ["plan"]);
    assert.equal(out.trim(), "No releasable changes detected for any component.");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plan fails loudly when contracts crates have divergent versions", () => {
  const repo = scaffoldRepo();
  try {
    writeFileSync(
      path.join(repo, "contracts/talos_governance/Cargo.toml"),
      '[package]\nname = "talos_governance"\nversion = "0.2.0"\n',
    );
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "fix(contracts): oops"]);

    const err = runCliExpectFailure(repo, ["plan"]);
    assert.match(err.stderr, /divergent versions/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
