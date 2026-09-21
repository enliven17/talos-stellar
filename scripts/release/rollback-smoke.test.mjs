// Release rollback smoke test.
//
// Drives the real release CLI against a throwaway git repo scaffolded to mirror
// the monorepo layout, exercising the full documented cycle end to end:
//
//   plan -> commit -> tag (release) -> rollback (delete local tag)
//        -> revert the release commit -> plan recomputes -> re-release
//
// It asserts the operational contract in RELEASES.md: rollback is explicit,
// idempotent, fails closed on ambiguous input, defaults to a dry run, never
// touches the remote, and never leaks credential material.
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

function runCli(repo, args, env) {
  return execFileSync("node", [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...(env || {}) },
  });
}

function runCliExpectFailure(repo, args) {
  try {
    runCli(repo, args);
    assert.fail("expected cli to exit with a non-zero status");
  } catch (err) {
    return err; // execFileSync throws with .status/.stdout/.stderr on non-zero exit
  }
}

function listTags(repo) {
  const out = sh(repo, "git", ["tag", "--list"]).trim();
  return out.length > 0 ? out.split("\n").sort() : [];
}

function readManifestVersion(repo, component) {
  const file = path.join(repo, component, "package.json");
  return JSON.parse(readFileSync(file, "utf8")).version;
}

function scaffoldRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "release-rollback-"));
  process.env.RELEASE_CLI_REPO_ROOT = dir;

  sh(dir, "git", ["init", "-q"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "user.name", "Test"]);

  for (const component of ["web", "packages/sdk"]) {
    mkdirSync(path.join(dir, component), { recursive: true });
    writeFileSync(
      path.join(dir, component, "package.json"),
      JSON.stringify({ name: component, version: "0.1.0" }, null, 2),
    );
  }

  mkdirSync(path.join(dir, "packages/prime-agent"), { recursive: true });
  writeFileSync(
    path.join(dir, "packages/prime-agent/pyproject.toml"),
    '[project]\nname = "talos-agent"\nversion = "0.1.0"\n',
  );

  for (const crate of ["talos_registry", "talos_name_service", "talos_governance"]) {
    mkdirSync(path.join(dir, "contracts", crate), { recursive: true });
    writeFileSync(
      path.join(dir, "contracts", crate, "Cargo.toml"),
      `[package]\nname = "${crate}"\nversion = "0.1.0"\n`,
    );
  }

  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "chore: scaffold monorepo"]);

  return dir;
}

// Cut and tag a baseline release for every component (web/sdk/agent/contracts).
function cutBaseline(repo) {
  runCli(repo, ["plan"]);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-q", "-m", "chore(release): cut baseline"]);
  runCli(repo, ["tag", "--create"]);
}

test("rollback --delete-tag removes only the targeted component's local tag", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);
    assert.deepEqual(listTags(repo), [
      "agent-v0.1.0",
      "contracts-v0.1.0",
      "sdk-v0.1.0",
      "web-v0.1.0",
    ]);

    const out = JSON.parse(runCli(repo, ["rollback", "--component=sdk", "--delete-tag", "--json"]));
    assert.equal(out.status, "deleted");
    assert.equal(out.tag, "sdk-v0.1.0");
    assert.equal(out.deleted, true);

    assert.deepEqual(listTags(repo), ["agent-v0.1.0", "contracts-v0.1.0", "web-v0.1.0"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rollback is idempotent, and --strict fails closed once the tag is gone", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);

    const first = JSON.parse(runCli(repo, ["rollback", "--component=sdk", "--delete-tag", "--json"]));
    assert.equal(first.status, "deleted");

    const second = JSON.parse(runCli(repo, ["rollback", "--component=sdk", "--delete-tag", "--json"]));
    assert.equal(second.status, "not-found");
    assert.equal(second.deleted, false);

    const err = runCliExpectFailure(repo, ["rollback", "--component=sdk", "--delete-tag", "--strict"]);
    assert.equal(err.status, 1);
    assert.match(err.stderr, /no tag named "sdk-v0\.1\.0" exists/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rollback fails closed on ambiguous or unknown selectors", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);

    const noSelector = runCliExpectFailure(repo, ["rollback"]);
    assert.match(noSelector.stderr, /--component=<name> or --tag=<tag>/);

    const bothSelectors = runCliExpectFailure(repo, [
      "rollback",
      "--component=sdk",
      "--tag=sdk-v0.1.0",
    ]);
    assert.match(bothSelectors.stderr, /not both/);

    const unknownComponent = runCliExpectFailure(repo, ["rollback", "--component=nope"]);
    assert.match(unknownComponent.stderr, /unknown component "nope"/);

    const malformedTag = runCliExpectFailure(repo, ["rollback", "--tag=not-a-release-tag"]);
    assert.match(malformedTag.stderr, /malformed tag/);

    // Failing closed must not have mutated any tags.
    assert.equal(listTags(repo).length, 4);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rollback defaults to a dry run and leaves the tag in place", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);

    const planned = JSON.parse(runCli(repo, ["rollback", "--component=web", "--json"]));
    assert.equal(planned.status, "dry-run");
    assert.equal(planned.deleted, false);
    assert.deepEqual(planned.remoteCommands, [
      "git push origin :refs/tags/web-v0.1.0",
      'gh release delete "web-v0.1.0" --yes',
    ]);
    assert.ok(listTags(repo).includes("web-v0.1.0"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rollback -> revert -> re-plan recomputes the same release (regression)", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);

    writeFileSync(path.join(repo, "packages/sdk/README.md"), "payments\n");
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "feat(sdk): add payments resource"]);

    const planned = runCli(repo, ["plan"]);
    assert.match(planned, /\*\*sdk\*\*: 0\.1\.0 -> 0\.2\.0 \(minor,/);
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "chore(release): sdk v0.2.0"]);
    runCli(repo, ["tag", "--create"]);
    assert.ok(listTags(repo).includes("sdk-v0.2.0"));
    assert.equal(readManifestVersion(repo, "packages/sdk"), "0.2.0");

    // Roll the published tag back and revert the version-bump commit.
    const rolled = JSON.parse(runCli(repo, ["rollback", "--component=sdk", "--delete-tag", "--json"]));
    assert.equal(rolled.status, "deleted");
    assert.ok(!listTags(repo).includes("sdk-v0.2.0"));
    assert.ok(listTags(repo).includes("sdk-v0.1.0"), "prior tag must survive a rollback");

    sh(repo, "git", ["revert", "--no-edit", "HEAD"]);
    assert.equal(readManifestVersion(repo, "packages/sdk"), "0.1.0");

    // The next plan deterministically re-proposes the same version, and the
    // release can be re-cut without a manual manifest edit.
    const replanned = runCli(repo, ["plan"]);
    assert.match(replanned, /\*\*sdk\*\*: 0\.1\.0 -> 0\.2\.0 \(minor,/);
    assert.doesNotMatch(replanned, /\*\*web\*\*/);
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["commit", "-q", "-m", "chore(release): sdk v0.2.0 (retry)"]);
    runCli(repo, ["tag", "--create"]);
    assert.ok(listTags(repo).includes("sdk-v0.2.0"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rollback output never leaks credential material", () => {
  const repo = scaffoldRepo();
  try {
    cutBaseline(repo);
    const secret = "ghp_fakeSecretValue1234567890";
    const env = { GITHUB_PAT_STFFINFCTI: secret, GH_TOKEN: secret, GITHUB_TOKEN: secret };

    const human = runCli(repo, ["rollback", "--tag=sdk-v0.1.0"], env);
    const json = runCli(repo, ["rollback", "--tag=sdk-v0.1.0", "--json"], env);
    for (const out of [human, json]) {
      assert.doesNotMatch(out, new RegExp(secret));
      assert.doesNotMatch(out, /-----BEGIN|ghp_[A-Za-z0-9]/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
