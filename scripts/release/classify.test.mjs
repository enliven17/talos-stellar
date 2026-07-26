import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCommit,
  bumpForCommit,
  bumpForCommits,
  applyBump,
  toPrerelease,
  renderChangelogSection,
} from "./classify.mjs";

test("parseCommit reads type, scope, and description", () => {
  const commit = parseCommit("feat(sdk): add payment resource client");
  assert.deepEqual(commit, {
    type: "feat",
    scope: "sdk",
    breaking: false,
    description: "add payment resource client",
  });
});

test("parseCommit detects breaking change via ! marker", () => {
  const commit = parseCommit("feat(api)!: drop legacy auth header");
  assert.equal(commit.breaking, true);
});

test("parseCommit detects breaking change via BREAKING CHANGE footer", () => {
  const commit = parseCommit("refactor: rework token storage", "BREAKING CHANGE: old tokens are invalid");
  assert.equal(commit.breaking, true);
});

test("parseCommit returns null for non-conventional subjects", () => {
  assert.equal(parseCommit("wip"), null);
  assert.equal(parseCommit("Merge branch 'main'"), null);
  assert.equal(parseCommit(""), null);
});

test("bumpForCommit maps type to severity", () => {
  assert.equal(bumpForCommit(parseCommit("feat: x")), "minor");
  assert.equal(bumpForCommit(parseCommit("fix: x")), "patch");
  assert.equal(bumpForCommit(parseCommit("perf: x")), "patch");
  assert.equal(bumpForCommit(parseCommit("docs: x")), "none");
  assert.equal(bumpForCommit(parseCommit("feat!: x")), "major");
  assert.equal(bumpForCommit(null), "none");
});

test("bumpForCommits takes the highest severity across all commits", () => {
  const commits = [parseCommit("docs: readme"), parseCommit("fix: null check"), parseCommit("feat: new endpoint")];
  assert.equal(bumpForCommits(commits), "minor");
});

test("bumpForCommits is major when any commit is breaking, regardless of order", () => {
  const commits = [parseCommit("feat: new endpoint"), parseCommit("fix!: remove default")];
  assert.equal(bumpForCommits(commits), "major");
});

test("bumpForCommits is none when nothing is releasable", () => {
  const commits = [parseCommit("docs: readme"), parseCommit("chore: bump deps"), null];
  assert.equal(bumpForCommits(commits), "none");
});

test("applyBump increments the right segment and resets lower ones", () => {
  assert.equal(applyBump("1.2.3", "patch"), "1.2.4");
  assert.equal(applyBump("1.2.3", "minor"), "1.3.0");
  assert.equal(applyBump("1.2.3", "major"), "2.0.0");
});

test("applyBump ignores an existing prerelease suffix on the input", () => {
  assert.equal(applyBump("1.2.3-beta.4", "patch"), "1.2.4");
});

test("applyBump rejects a malformed version", () => {
  assert.throws(() => applyBump("not-a-version", "patch"), /invalid semver/);
});

test("applyBump rejects an unknown bump kind", () => {
  assert.throws(() => applyBump("1.0.0", "sideways"), /cannot apply bump/);
});

test("toPrerelease appends a channel and index", () => {
  assert.equal(toPrerelease("1.2.0", "beta", 0), "1.2.0-beta.0");
  assert.equal(toPrerelease("1.2.0", "beta", 3), "1.2.0-beta.3");
});

test("renderChangelogSection groups entries under their bump heading", () => {
  const md = renderChangelogSection({
    component: "sdk",
    version: "1.3.0",
    date: "2026-07-24",
    entries: [
      { sha: "abc1234", subject: "feat: add x", commit: parseCommit("feat: add x") },
      { sha: "def5678", subject: "fix: y", commit: parseCommit("fix: y") },
      { sha: "aaa1111", subject: "chore: bump", commit: parseCommit("chore: bump") },
    ],
  });

  assert.match(md, /^## sdk v1\.3\.0 - 2026-07-24/);
  assert.match(md, /### Features\n\n- add x \(abc1234\)/);
  assert.match(md, /### Fixes\n\n- y \(def5678\)/);
  assert.match(md, /### Other Changes\n\n- bump \(aaa1111\)/);
});

test("renderChangelogSection omits headings with no entries", () => {
  const md = renderChangelogSection({
    component: "agent",
    version: "0.2.0",
    date: "2026-07-24",
    entries: [{ sha: "abc1234", subject: "feat: add y", commit: parseCommit("feat: add y") }],
  });
  assert.doesNotMatch(md, /Breaking Changes/);
  assert.doesNotMatch(md, /Fixes/);
  assert.doesNotMatch(md, /Other Changes/);
});
