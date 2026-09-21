// Safe, explicit rollback of the component release tags created by `cli.mjs tag`.
//
// Design constraints (see the "Rollback" section of RELEASES.md):
//   - Tags are immutable once pushed. This tool only ever deletes a *local*
//     tag; the destructive remote cleanup commands are returned for an operator
//     to run deliberately. It never force-pushes or re-points an existing tag.
//   - Ambiguous selectors fail closed instead of guessing which tag to remove.
//   - The default is a dry run; mutating the repo requires `--delete-tag`.
//   - Errors are explicit and privacy-safe: they never embed tokens, seeds,
//     payment proofs, or other credentials (this module reads none).
import path from "node:path";
import { COMPONENTS } from "./components.mjs";
import { readVersion } from "./version-files.mjs";
import { tagExists, deleteTag } from "./git.mjs";

const TAG_RE = /^([a-z][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export class RollbackInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RollbackInputError";
  }
}

export function componentNames() {
  return COMPONENTS.map((c) => c.name);
}

export function resolveComponent(name) {
  const component = COMPONENTS.find((c) => c.name === name);
  if (!component) {
    throw new RollbackInputError(
      `unknown component "${name}"; expected one of: ${componentNames().join(", ")}`,
    );
  }
  return component;
}

export function componentFromTag(tag) {
  const match = TAG_RE.exec(String(tag ?? "").trim());
  if (!match) {
    throw new RollbackInputError(
      `malformed tag "${tag}"; expected <component>-v<semver> (e.g. sdk-v1.2.3)`,
    );
  }
  return resolveComponent(match[1]);
}

function readComponentVersion(component, repoRoot) {
  const versions = component.manifests.map((m) => readVersion(path.join(repoRoot, m.file), m.kind));
  const distinct = new Set(versions);
  if (distinct.size > 1) {
    throw new Error(
      `component "${component.name}" has manifests with divergent versions: ` +
        component.manifests.map((m, i) => `${m.file}=${versions[i]}`).join(", "),
    );
  }
  return versions[0];
}

/**
 * Resolve the exact tag a rollback targets. Exactly one of `componentName` or
 * `tag` must be supplied — ambiguous or empty input fails closed.
 *
 * @returns {{component: object, tag: string, exists: boolean}}
 */
export function resolveTarget({ repoRoot, componentName = null, tag = null }) {
  if (componentName && tag) {
    throw new RollbackInputError("specify either --component or --tag, not both");
  }
  if (!componentName && !tag) {
    throw new RollbackInputError("specify --component=<name> or --tag=<tag>");
  }
  const component = tag ? componentFromTag(tag) : resolveComponent(componentName);
  const resolvedTag = tag
    ? String(tag).trim()
    : `${component.name}-v${readComponentVersion(component, repoRoot)}`;
  return { component, tag: resolvedTag, exists: tagExists(repoRoot, resolvedTag) };
}

/**
 * The destructive remote cleanup an operator runs by hand after a local
 * rollback. Kept separate from `rollbackRelease` so automation can never
 * delete a published tag or release implicitly.
 */
export function remoteCleanupCommands(tag) {
  return [`git push origin :refs/tags/${tag}`, `gh release delete "${tag}" --yes`];
}

/**
 * Roll back a component release tag.
 *
 * @param {object} params
 * @param {string} params.repoRoot repository to operate on
 * @param {string|null} [params.componentName] component to roll back
 * @param {string|null} [params.tag] explicit tag to roll back
 * @param {boolean} [params.deleteTag] apply the local deletion (default: dry run)
 * @param {boolean} [params.strict] fail when the tag is already gone
 * @returns {{status: "dry-run"|"deleted"|"not-found", component: string, tag: string, deleted: boolean, remoteCommands: string[], message: string}}
 */
export function rollbackRelease({
  repoRoot,
  componentName = null,
  tag = null,
  deleteTag: removeTag = false,
  strict = false,
}) {
  const target = resolveTarget({ repoRoot, componentName, tag });

  if (!target.exists) {
    const message =
      `no tag named "${target.tag}" exists for component "${target.component.name}" ` +
      `(already rolled back?)`;
    if (strict) throw new RollbackInputError(message);
    return {
      status: "not-found",
      component: target.component.name,
      tag: target.tag,
      deleted: false,
      remoteCommands: [],
      message,
    };
  }

  if (removeTag) deleteTag(repoRoot, target.tag);

  return {
    status: removeTag ? "deleted" : "dry-run",
    component: target.component.name,
    tag: target.tag,
    deleted: removeTag,
    remoteCommands: remoteCleanupCommands(target.tag),
    message: removeTag
      ? `deleted local tag "${target.tag}"; run the listed remote cleanup commands to finish`
      : `would delete local tag "${target.tag}"; re-run with --delete-tag to apply`,
  };
}
