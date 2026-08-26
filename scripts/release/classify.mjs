// Pure, git/fs-free logic for turning Conventional Commit subjects into a
// semver bump and a changelog section. Kept dependency-free and side-effect
// free so it can be unit tested without a real repo.

const CONVENTIONAL_RE = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;

const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * @param {string} subject first line of a commit message
 * @param {string} body remainder of the commit message
 * @returns {{type: string, scope: string|null, breaking: boolean, description: string} | null}
 *   null when the subject does not follow Conventional Commits — such
 *   commits are recorded but never drive a version bump.
 */
export function parseCommit(subject, body = "") {
  const trimmed = (subject || "").trim();
  const match = CONVENTIONAL_RE.exec(trimmed);
  if (!match) return null;

  const [, type, , scope, bang, description] = match;
  const breaking = Boolean(bang) || /BREAKING[ -]CHANGE:/.test(body || "");

  return {
    type: type.toLowerCase(),
    scope: scope || null,
    breaking,
    description: description.trim(),
  };
}

/**
 * @param {ReturnType<typeof parseCommit>} commit
 * @returns {'major'|'minor'|'patch'|'none'}
 */
export function bumpForCommit(commit) {
  if (!commit) return "none";
  if (commit.breaking) return "major";
  if (commit.type === "feat") return "minor";
  if (commit.type === "fix" || commit.type === "perf") return "patch";
  return "none";
}

/**
 * @param {Array<ReturnType<typeof parseCommit>>} commits
 * @returns {'major'|'minor'|'patch'|'none'}
 */
export function bumpForCommits(commits) {
  let best = "none";
  for (const commit of commits) {
    const bump = bumpForCommit(commit);
    if (BUMP_RANK[bump] > BUMP_RANK[best]) best = bump;
  }
  return best;
}

/**
 * @param {string} version current "MAJOR.MINOR.PATCH" (prerelease suffix, if any, is ignored)
 * @param {'major'|'minor'|'patch'} bump
 */
export function applyBump(version, bump) {
  const base = String(version).split("-")[0];
  const parts = base.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`invalid semver version: ${version}`);
  }
  let [major, minor, patch] = parts;
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else if (bump === "patch") {
    patch += 1;
  } else {
    throw new Error(`cannot apply bump "${bump}"`);
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Appends an incrementing prerelease identifier, e.g. "1.2.0" + "beta" -> "1.2.0-beta.0".
 * @param {string} baseVersion
 * @param {string} channel
 * @param {number} nextIndex
 */
export function toPrerelease(baseVersion, channel, nextIndex) {
  return `${baseVersion}-${channel}.${nextIndex}`;
}

const SECTION_ORDER = [
  ["major", "Breaking Changes"],
  ["minor", "Features"],
  ["patch", "Fixes"],
  ["none", "Other Changes"],
];

/**
 * @param {{component: string, version: string, date: string, entries: Array<{sha: string, commit: ReturnType<typeof parseCommit>, subject: string}>}} params
 */
export function renderChangelogSection({ component, version, date, entries }) {
  const byBump = { major: [], minor: [], patch: [], none: [] };
  for (const entry of entries) {
    const bump = bumpForCommit(entry.commit);
    const line = entry.commit
      ? `- ${entry.commit.description} (${entry.sha})`
      : `- ${entry.subject} (${entry.sha})`;
    byBump[bump].push(line);
  }

  const lines = [`## ${component} v${version} - ${date}`, ""];
  for (const [bump, heading] of SECTION_ORDER) {
    if (byBump[bump].length === 0) continue;
    lines.push(`### ${heading}`, "", ...byBump[bump], "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
