# Release Process

Talos Protocol ships four independently versioned components:

| Component   | Path                     | Manifest(s)                                                                                            | Tag format         |
|-------------|--------------------------|-----------------------------------------------------------------------------------------------------------|---------------------|
| `web`       | `web/`                   | `web/package.json`                                                                                       | `web-vX.Y.Z`        |
| `sdk`       | `packages/sdk/`          | `packages/sdk/package.json`                                                                               | `sdk-vX.Y.Z`        |
| `agent`     | `packages/prime-agent/`  | `packages/prime-agent/pyproject.toml`                                                                     | `agent-vX.Y.Z`      |
| `contracts` | `contracts/`             | `contracts/talos_registry/Cargo.toml`, `contracts/talos_name_service/Cargo.toml`, `contracts/talos_governance/Cargo.toml` | `contracts-vX.Y.Z`  |

Contracts are versioned as one unit — the three Soroban crates are built, tested, and deployed
together (see `contracts-ci.yml`), so lockstep versions keep them from drifting apart.

The process is driven by [`scripts/release/`](scripts/release) and two workflows. Nothing in
either workflow publishes anything without a human merging a PR first.

## How it works

1. **`Release Plan`** ([`.github/workflows/release-plan.yml`](.github/workflows/release-plan.yml))
   runs on every push to `main`. It classifies commits since each component's last release tag
   using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` → minor bump
   - `fix:` / `perf:` → patch bump
   - a `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer → major bump
   - anything else (`docs:`, `chore:`, `refactor:`, etc.) doesn't trigger a release on its own

   A component with no commits since its last tag, or only non-releasing commits, is left alone —
   there is never an empty release. If any component has releasable changes, the workflow opens or
   updates a `chore(release): version bump` pull request with the bumped manifest(s) and an updated
   `CHANGELOG.md` per component (created on first use).

   **This PR is the approval gate.** A maintainer reviews the computed versions and changelog
   entries and merges (or edits and merges) it like any other PR. Nothing is tagged yet.

2. **`Release Publish`** ([`.github/workflows/release-publish.yml`](.github/workflows/release-publish.yml))
   runs when a `chore(release)` commit lands on `main`. For every component whose manifest version
   doesn't already have a matching git tag, it:
   - creates and pushes an annotated tag (`<component>-vX.Y.Z`)
   - builds that component's release artifact (sdk: npm tarball, agent: wheel + sdist, contracts:
     wasm binaries; web has no build artifact here since it's already deployed via
     [`deploy.yml`](.github/workflows/deploy.yml) on every push to `main`)
   - publishes a GitHub Release with the corresponding changelog section as its notes

   Tag creation is idempotent — components that already have a tag matching their current manifest
   version are skipped — so re-running this workflow after a partial failure only finishes what's
   left; it never double-tags or double-releases.

## Prereleases

Trigger `Release Plan` manually (`workflow_dispatch`) with a `prerelease` input of `beta` or `rc`
to compute `X.Y.Z-beta.N` / `X.Y.Z-rc.N` versions instead of stable ones. Everything downstream
(the PR, the tag, the GitHub Release) works identically; the release is marked "prerelease" on
GitHub automatically.

## Rollback

- **Before the release PR is merged**: close the PR without merging. `Release Plan` will
  recompute it on the next push.
- **After a tag/release was published but should not have been**: delete the GitHub Release and
  the tag (`git push origin :refs/tags/<tag>`). Do not edit or delete the merged manifest/changelog
  commit — open a new PR that reverts it, and let `Release Plan` pick up the next real release
  from there. Tags are treated as immutable once pushed; never force-push or re-tag an existing
  version.
- **A bad version shipped**: cut a new patch/major release with the fix rather than mutating the
  old tag. Consumers that pinned the bad version are unaffected until they upgrade.

## Local reproduction

```bash
# See what would be released, without a real PR:
node scripts/release/cli.mjs plan --summary-out=/tmp/summary.md
git diff   # inspect the computed bumps and changelog entries
git checkout -- .   # discard the dry run

# Run the test suite for the release scripts:
node --test scripts/release/*.test.mjs
```

## Limitations

- Version classification is per-commit-subject only; it does not inspect diffs, so a commit
  mislabeled with the wrong Conventional Commit type will bump the wrong severity.
- The four manifests are the source of truth. Manually editing a version number without going
  through the release PR will desync it from its git tag history — `plan`/`tag` will still work
  off whatever the manifest says, so keep manual edits out of the affected commits.
- `contracts`'s three crates must always share one version; a mismatch fails `plan`/`tag` loudly
  rather than guessing which one is right.
