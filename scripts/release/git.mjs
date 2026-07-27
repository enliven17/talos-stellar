import { execFileSync } from "node:child_process";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Most recent tag matching a glob (e.g. "web-v*"), or null if there is none yet.
 */
export function latestTag(cwd, pattern) {
  const out = git(cwd, ["tag", "--list", pattern, "--sort=-v:refname"]);
  const first = out.split("\n").find((line) => line.trim().length > 0);
  return first || null;
}

export function tagExists(cwd, tag) {
  const out = git(cwd, ["tag", "--list", tag]);
  return out.trim().length > 0;
}

/**
 * Commits touching `paths`, oldest first. `sinceTag` is exclusive; when null
 * the full history reachable from HEAD is used.
 */
export function commitsTouchingPaths(cwd, sinceTag, paths) {
  const range = sinceTag ? `${sinceTag}..HEAD` : "HEAD";
  const out = git(cwd, [
    "log",
    range,
    "--reverse",
    "--pretty=format:%H",
    "--",
    ...paths,
  ]);
  if (!out) return [];

  return out.split("\n").map((sha) => {
    const subject = git(cwd, ["show", "-s", "--format=%s", sha]);
    const body = git(cwd, ["show", "-s", "--format=%b", sha]);
    return { sha: sha.slice(0, 7), subject, body };
  });
}

export function createAnnotatedTag(cwd, tag, message) {
  git(cwd, ["tag", "-a", tag, "-m", message]);
}
