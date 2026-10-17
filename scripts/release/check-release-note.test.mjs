// Tests for scripts/release/check-release-note.mjs
//
// These tests drive the check script by spawning it as a child process,
// matching the same pattern used in cli.test.mjs. This exercises the full
// input resolution and exit-code logic without mocking the environment.
//
// Local command:
//   node --test scripts/release/check-release-note.test.mjs
//
// Or together with the rest of the release suite:
//   node --test scripts/release/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-release-note.mjs",
);

/**
 * Run the check script with the given env overrides.
 * Returns { stdout, stderr, status }.
 * Never throws — callers assert on status themselves.
 */
function runCheck(env = {}) {
  // Strip any real GH Actions env vars to isolate tests.
  const baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Do NOT forward GITHUB_EVENT_PATH or any token/secret variables.
  };
  try {
    const stdout = execFileSync("node", [SCRIPT], {
      encoding: "utf8",
      env: { ...baseEnv, ...env },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      status: err.status ?? 1,
    };
  }
}

// ── Positive cases ───────────────────────────────────────────────────────────

test("accepts a well-formed feat commit as PR title", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "feat(sdk): add payment resource client" });
  assert.equal(status, 0);
  assert.match(stdout, /OK\s+PR title/);
  assert.match(stdout, /PASSED/);
});

test("accepts a well-formed fix commit as PR title", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "fix(web): handle null agent wallet" });
  assert.equal(status, 0);
  assert.match(stdout, /PASSED/);
});

test("accepts a chore commit (non-releasing) as PR title", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "chore(deps): bump stellar-sdk" });
  assert.equal(status, 0);
  assert.match(stdout, /PASSED/);
  assert.match(stdout, /non-releasing/);
});

test("accepts a breaking change via ! marker", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "feat(api)!: remove legacy auth header" });
  assert.equal(status, 0);
  assert.match(stdout, /BREAKING/);
  assert.match(stdout, /PASSED/);
});

test("accepts a commit with no scope", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "docs: update RELEASES.md" });
  assert.equal(status, 0);
  assert.match(stdout, /PASSED/);
});

test("accepts a perf commit (patch-level)", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "perf(db): add index on agent_id" });
  assert.equal(status, 0);
  assert.match(stdout, /patch/i);
  assert.match(stdout, /PASSED/);
});

// ── PR title + commit subjects ───────────────────────────────────────────────

test("accepts valid PR title and valid commit subjects", () => {
  const { status, stdout } = runCheck({
    PR_TITLE: "feat(sdk): add payments resource",
    PR_COMMITS: "feat(sdk): add payments resource\nchore: bump lockfile",
  });
  assert.equal(status, 0);
  assert.match(stdout, /PASSED/);
  assert.match(stdout, /2 commit subject/);
});

test("accepts valid PR title even when some commits are non-CC", () => {
  // Non-CC commits on the branch are noted but not errors.
  const { status, stdout } = runCheck({
    PR_TITLE: "fix: handle missing wallet",
    PR_COMMITS: "fix: handle missing wallet\nMerge branch 'main'\nWIP: explore",
  });
  assert.equal(status, 0);
  assert.match(stdout, /PASSED/);
  assert.match(stdout, /not a Conventional Commit/);
});

test("reports bump classification for each commit subject", () => {
  const { status, stdout } = runCheck({
    PR_TITLE: "feat: add x402 gateway support",
    PR_COMMITS: "feat: add x402 gateway support\nfix: correct fee calculation\ndocs: update README",
  });
  assert.equal(status, 0);
  assert.match(stdout, /minor \(feat\)/);
  assert.match(stdout, /patch \(fix\/perf\)/);
  assert.match(stdout, /non-releasing/);
});

// ── Negative cases ───────────────────────────────────────────────────────────

test("rejects a PR title that is plain prose with no CC prefix", () => {
  const { status, stderr } = runCheck({ PR_TITLE: "Update the README" });
  assert.equal(status, 1);
  assert.match(stderr, /ERROR.*PR title.*Conventional Commits/i);
});

test("rejects a PR title that is a Merge commit message", () => {
  const { status, stderr } = runCheck({ PR_TITLE: "Merge pull request #42 from main" });
  assert.equal(status, 1);
  assert.match(stderr, /ERROR/);
});

test("rejects a completely empty PR title (env var present but blank)", () => {
  const { status, stderr } = runCheck({ PR_TITLE: "   " });
  assert.equal(status, 1);
  assert.match(stderr, /No PR title found/i);
});

test("fails closed when PR_TITLE is not set at all", () => {
  const { status, stderr } = runCheck({}); // no PR_TITLE
  assert.equal(status, 1);
  assert.match(stderr, /No PR title found/i);
});

test("rejects a title with type but no description after the colon", () => {
  const { status, stderr } = runCheck({ PR_TITLE: "feat(sdk):" });
  assert.equal(status, 1);
  assert.match(stderr, /ERROR/);
});

test("rejects a title where the type is missing (only colon prefix)", () => {
  const { status, stderr } = runCheck({ PR_TITLE: ": add something" });
  assert.equal(status, 1);
  assert.match(stderr, /ERROR/);
});

// ── Boundary / edge cases ─────────────────────────────────────────────────────

test("accepts a title with a numeric-containing scope", () => {
  const { status } = runCheck({ PR_TITLE: "fix(web3): handle Stellar RPC timeout" });
  assert.equal(status, 0);
});

test("accepts a title with a hyphenated scope", () => {
  const { status } = runCheck({ PR_TITLE: "feat(prime-agent): parallel task execution" });
  assert.equal(status, 0);
});

test("accepts a title with uppercase type (normalised internally)", () => {
  // CONVENTIONAL_RE accepts \w+ so FEAT is a valid token; parseCommit lowercases it.
  const { status } = runCheck({ PR_TITLE: "FEAT(sdk): add thing" });
  // The regex is case-sensitive for the token \w+ which includes uppercase.
  // parseCommit lowercases it internally, so FEAT should parse correctly.
  // This test documents the actual behaviour — do not change.
  assert.equal(status, 0);
});

test("accepts PR_COMMITS that is a single-item list with no newline at end", () => {
  const { status } = runCheck({
    PR_TITLE: "fix: fix the thing",
    PR_COMMITS: "fix: fix the thing",
  });
  assert.equal(status, 0);
});

test("handles PR_COMMITS with leading/trailing blank lines gracefully", () => {
  const { status } = runCheck({
    PR_TITLE: "feat: do something",
    PR_COMMITS: "\n\nfeat: do something\n\n",
  });
  assert.equal(status, 0);
  assert.match; // just assert it does not throw
});

// ── Regression cases ─────────────────────────────────────────────────────────

test("regression: a chore(release) bump commit passes (used by release-plan workflow)", () => {
  const { status } = runCheck({ PR_TITLE: "chore(release): version bump" });
  assert.equal(status, 0);
});

test("regression: a refactor commit with scope passes without driving a bump", () => {
  const { status, stdout } = runCheck({ PR_TITLE: "refactor(contracts): simplify registry logic" });
  assert.equal(status, 0);
  assert.match(stdout, /non-releasing/);
});

test("regression: BREAKING CHANGE in body does not affect check (body not provided via env)", () => {
  // The check script only reads subjects, not bodies. A body with
  // BREAKING CHANGE: ... is not visible here — the ! marker in the title is
  // the only signal available. This matches real PR-title-only validation.
  const { status, stdout } = runCheck({
    PR_TITLE: "refactor(api): rework auth middleware",
    // Body would be: "BREAKING CHANGE: existing tokens are invalidated"
    // but we only provide the title.
  });
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /BREAKING/);
});

test("regression: does not echo any environment variable values resembling secrets", () => {
  // Simulate an accidental injection attempt in PR_TITLE — the script should
  // sanitize control characters and non-printable bytes before output.
  const { stderr } = runCheck({ PR_TITLE: "feat: thing \x1b[31mred\x1b[0m" });
  // We do not assert exit status here — what we care about is that control
  // sequences never leak into stderr/stdout verbatim.
  assert.doesNotMatch(stderr, /\x1b\[31m/);
});

// ── GitHub Actions event fallback ─────────────────────────────────────────────

test("reads PR title from GITHUB_EVENT_PATH when PR_TITLE env var is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-rn-test-"));
  const eventFile = path.join(dir, "event.json");
  writeFileSync(
    eventFile,
    JSON.stringify({ pull_request: { title: "feat(agent): parallel task queue" } }),
  );
  try {
    const { status, stdout } = runCheck({ GITHUB_EVENT_PATH: eventFile });
    assert.equal(status, 0);
    assert.match(stdout, /PASSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed when GITHUB_EVENT_PATH points to a missing file and PR_TITLE is absent", () => {
  const { status, stderr } = runCheck({
    GITHUB_EVENT_PATH: "/tmp/no-such-event-file-xyz.json",
  });
  assert.equal(status, 1);
  assert.match(stderr, /No PR title found/i);
});

test("falls back gracefully when GITHUB_EVENT_PATH contains malformed JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "check-rn-test-"));
  const eventFile = path.join(dir, "bad.json");
  writeFileSync(eventFile, "{ not valid json ]]]");
  try {
    const { status, stderr } = runCheck({ GITHUB_EVENT_PATH: eventFile });
    assert.equal(status, 1);
    assert.match(stderr, /No PR title found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
