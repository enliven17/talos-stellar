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
 * Removes a local tag. Only the local ref is deleted — pushing the deletion
 * (/ force-updating a published tag) is an explicit, separate operator action.
 */
export function deleteTag(cwd, tag) {
  git(cwd, ["tag", "--delete", tag]);
}

/**
 * Fails closed with an explicit error when `cwd` is not inside a git work tree,
 * so rollback never reports success against the wrong directory.
 */
export function ensureRepository(cwd) {
  try {
    const out = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (out !== "true") throw new Error("not a work tree");
  } catch {
    throw new Error(`not a git repository: ${cwd}`);
  }
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
