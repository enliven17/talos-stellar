#!/usr/bin/env node
// Component-aware release planner/tagger for web, sdk, agent, and contracts.
//
// Usage:
//   node scripts/release/cli.mjs plan [--prerelease=<channel>] [--summary-out=<file>]
//   node scripts/release/cli.mjs tag [--create]
//
// See RELEASES.md for the full workflow this drives.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  parseCommit,
  bumpForCommits,
  applyBump,
  toPrerelease,
  renderChangelogSection,
} from "./classify.mjs";
import { readVersion, writeVersion } from "./version-files.mjs";
import { COMPONENTS } from "./components.mjs";
import { latestTag, tagExists, commitsTouchingPaths, createAnnotatedTag } from "./git.mjs";

// Overridable so integration tests can point the CLI at a throwaway repo
// instead of the real one.
const REPO_ROOT = process.env.RELEASE_CLI_REPO_ROOT || path.resolve(new URL("../..", import.meta.url).pathname);

function readComponentVersion(component) {
  const versions = component.manifests.map((m) => readVersion(path.join(REPO_ROOT, m.file), m.kind));
  const distinct = new Set(versions);
  if (distinct.size > 1) {
    throw new Error(
      `component "${component.name}" has manifests with divergent versions: ` +
        component.manifests.map((m, i) => `${m.file}=${versions[i]}`).join(", "),
    );
  }
  return versions[0];
}

function writeComponentVersion(component, version) {
  for (const m of component.manifests) {
    writeVersion(path.join(REPO_ROOT, m.file), m.kind, version);
  }
}

function prependChangelog(component, section) {
  const file = path.join(REPO_ROOT, component.changelog);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : `# ${component.name} Changelog\n\n`;
  const [header, ...rest] = existing.split("\n\n");
  const body = rest.join("\n\n");
  const updated = body
    ? `${header}\n\n${section}\n${body}`
    : `${header}\n\n${section}`;
  writeFileSync(file, updated.trimEnd() + "\n");
}

function extractChangelogSection(component, version) {
  const file = path.join(REPO_ROOT, component.changelog);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const heading = `## ${component.name} v${version} -`;
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const rest = text.slice(start);
  const nextHeading = rest.indexOf("\n## ", 1);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

function nextPrereleaseIndex(cwd, name, baseVersion, channel) {
  const pattern = `${name}-v${baseVersion}-${channel}.*`;
  // latestTag sorts by version, so scanning all matches is unnecessary — the
  // count of existing matches is enough to pick the next index.
  const out = latestTag(cwd, pattern);
  if (!out) return 0;
  const match = /\.(\d+)$/.exec(out);
  return match ? Number(match[1]) + 1 : 0;
}

function planCommand(args) {
  const prerelease = args.find((a) => a.startsWith("--prerelease="))?.split("=")[1] || null;
  const summaryOut = args.find((a) => a.startsWith("--summary-out="))?.split("=")[1] || null;

  const results = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const component of COMPONENTS) {
    const currentVersion = readComponentVersion(component);
    const tagPattern = `${component.name}-v*`;
    const lastTag = latestTag(REPO_ROOT, tagPattern);

    const commits = commitsTouchingPaths(REPO_ROOT, lastTag, component.paths);
    if (commits.length === 0) continue;

    const parsed = commits.map((c) => ({ ...c, commit: parseCommit(c.subject, c.body) }));
    const bump = bumpForCommits(parsed.map((p) => p.commit));

    let baseVersion;
    let bumpApplied;
    if (!lastTag) {
      // First-ever release for this component: cut whatever is already in
      // the manifest as the baseline instead of guessing a bump.
      baseVersion = currentVersion;
      bumpApplied = "baseline";
    } else {
      if (bump === "none") continue; // only docs/chore/etc touched this component
      baseVersion = applyBump(currentVersion, bump);
      bumpApplied = bump;
    }

    const targetVersion = prerelease
      ? toPrerelease(baseVersion, prerelease, nextPrereleaseIndex(REPO_ROOT, component.name, baseVersion, prerelease))
      : baseVersion;

    writeComponentVersion(component, targetVersion);
    prependChangelog(component, renderChangelogSection({
      component: component.name,
      version: targetVersion,
      date: today,
      entries: parsed.map((p) => ({ sha: p.sha, commit: p.commit, subject: p.subject })),
    }));

    results.push({ name: component.name, from: currentVersion, to: targetVersion, bump: bumpApplied, commits: commits.length });
  }

  if (results.length === 0) {
    console.log("No releasable changes detected for any component.");
    return;
  }

  const lines = ["# Release Plan", ""];
  for (const r of results) {
    lines.push(`- **${r.name}**: ${r.from} -> ${r.to} (${r.bump}, ${r.commits} commit${r.commits === 1 ? "" : "s"})`);
  }
  const summary = lines.join("\n") + "\n";
  console.log(summary);
  if (summaryOut) writeFileSync(summaryOut, summary);
}

function tagCommand(args) {
  const create = args.includes("--create");
  const notesDir = args.find((a) => a.startsWith("--notes-dir="))?.split("=")[1] || null;
  if (notesDir) mkdirSync(notesDir, { recursive: true });

  const releasable = [];

  for (const component of COMPONENTS) {
    const version = readComponentVersion(component);
    const tag = `${component.name}-v${version}`;
    if (tagExists(REPO_ROOT, tag)) continue;

    const notes = extractChangelogSection(component, version) || `Release ${tag}`;
    releasable.push({ name: component.name, version, tag, prerelease: version.includes("-") });
    if (notesDir) writeFileSync(path.join(notesDir, `${component.name}.md`), notes + "\n");

    if (create) {
      createAnnotatedTag(REPO_ROOT, tag, `${component.name} v${version}`);
    }
  }

  console.log(JSON.stringify(releasable, null, 2));
}

const [, , command, ...rest] = process.argv;

if (command === "plan") {
  planCommand(rest);
} else if (command === "tag") {
  tagCommand(rest);
} else {
  console.error("usage: cli.mjs <plan|tag> [options]");
  process.exit(1);
}
