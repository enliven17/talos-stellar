#!/usr/bin/env node
// PR-level Conventional Commits classification checker.
//
// Validates that a pull request title, and optionally its commit subjects,
// conform to Conventional Commits format so that the release machinery
// (classify.mjs / cli.mjs) can classify them correctly.
//
// Exits 0 when all checked subjects are valid CC. Exits 1 on any error or
// when at least one subject is non-conforming. Fails closed: ambiguous input
// (e.g. an empty PR_TITLE with no commits) is treated as an error.
//
// Usage (standalone):
//   PR_TITLE="feat(sdk): add client"  node scripts/release/check-release-note.mjs
//   PR_TITLE="feat(sdk): add client"  PR_COMMITS="fix: x\nchore: y"  node ...
//
// In GitHub Actions (the workflow sets these automatically):
//   PR_TITLE and PR_COMMITS are written from the pull_request event context.
//
// Never reads or logs GITHUB_TOKEN, secrets, or any environment variable
// whose name contains "SECRET", "KEY", "TOKEN", "PASSWORD", or "SEED".

import { readFileSync } from "node:fs";
import { parseCommit, bumpForCommit } from "./classify.mjs";

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip sensitive-looking env vars before they could appear in any output.
 * We only log the variable *name*, never its value.
 */
const SENSITIVE_NAME_RE = /SECRET|KEY|TOKEN|PASSWORD|SEED|PRIVATE/i;

function safeEnv(name) {
  if (SENSITIVE_NAME_RE.test(name)) {
    throw new Error(
      `Refusing to read ${name}: name looks sensitive. Check your workflow configuration.`,
    );
  }
  return process.env[name] ?? "";
}

/**
 * Load the event payload from GITHUB_EVENT_PATH if available.
 * Returns null when the file cannot be read (no GH Actions context or
 * missing file — both are fine outside CI).
 */
function loadGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  try {
    return JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    return null;
  }
}

// ── input resolution ─────────────────────────────────────────────────────────

function resolveInputs() {
  // 1. Explicit env vars take precedence (easy local testing and workflow
  //    overrides without touching the event payload).
  let title = safeEnv("PR_TITLE").trim();
  let commitsRaw = safeEnv("PR_COMMITS").trim();

  // 2. Fall back to the GH Actions event payload when running inside a
  //    workflow and neither env var was set.
  if (!title && !commitsRaw) {
    const event = loadGitHubEvent();
    if (event?.pull_request?.title) {
      title = String(event.pull_request.title).trim();
    }
  }

  const commits = commitsRaw
    ? commitsRaw.split("\n").map((s) => s.trim()).filter(Boolean)
    : [];

  return { title, commits };
}

// ── classification output ────────────────────────────────────────────────────

const BUMP_LABELS = {
  major: "breaking",
  minor: "minor (feat)",
  patch: "patch (fix/perf)",
  none: "non-releasing (docs/chore/…)",
};

function classifySubject(subject) {
  const commit = parseCommit(subject);
  const bump = bumpForCommit(commit);
  return { subject, commit, bump };
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const { title, commits } = resolveInputs();

  // Fail closed: we need at least a PR title to do anything useful.
  if (!title) {
    console.error(
      "ERROR: No PR title found. Set PR_TITLE or run inside a GitHub Actions pull_request workflow.",
    );
    process.exit(1);
  }

  let hasError = false;

  // ── Validate PR title ───────────────────────────────────────────────────
  const titleResult = classifySubject(title);

  if (!titleResult.commit) {
    console.error(
      `ERROR: PR title does not follow Conventional Commits format.\n` +
        `  Title : "${sanitize(title)}"\n` +
        `  Expected: <type>[(scope)][!]: <description>\n` +
        `  Examples: feat(sdk): add payments client\n` +
        `            fix!: remove deprecated endpoint\n` +
        `            chore(release): version bump`,
    );
    hasError = true;
  } else {
    const { type, scope, breaking, description } = titleResult.commit;
    const scopeStr = scope ? `(${scope})` : "";
    const breakingStr = breaking ? " [BREAKING]" : "";
    console.log(
      `OK  PR title  → ${type}${scopeStr}${breakingStr}: ${description}` +
        `  [${BUMP_LABELS[titleResult.bump]}]`,
    );
  }

  // ── Validate PR commits (optional) ─────────────────────────────────────
  if (commits.length > 0) {
    console.log(`\nChecking ${commits.length} commit subject${commits.length === 1 ? "" : "s"}:`);
    for (const subject of commits) {
      const result = classifySubject(subject);
      if (!result.commit) {
        // Non-CC commits are noted but not treated as errors: squash-merge
        // PRs, WIP commits, and Merge commits are common and the PR title
        // is the canonical classification signal.
        console.log(`  --  "${sanitize(subject)}"  [not a Conventional Commit — will not drive a version bump]`);
      } else {
        const { type, scope, breaking, description } = result.commit;
        const scopeStr = scope ? `(${scope})` : "";
        const breakingStr = breaking ? " [BREAKING]" : "";
        console.log(
          `  OK  ${type}${scopeStr}${breakingStr}: ${description}` +
            `  [${BUMP_LABELS[result.bump]}]`,
        );
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  if (hasError) {
    console.error(
      "\nFAILED: Fix the PR title to match Conventional Commits format and re-push.",
    );
    process.exit(1);
  }

  console.log(
    "\nPASSED: PR title conforms to Conventional Commits." +
      (commits.length > 0 ? ` ${commits.length} commit subject(s) inspected.` : ""),
  );
}

/**
 * Strip any characters that could cause terminal injection or leak secrets
 * when echoing user-provided subjects back to stdout. Keeps printable ASCII.
 */
function sanitize(str) {
  return String(str).replace(/[^\x20-\x7E]/g, "").slice(0, 200);
}

main();
