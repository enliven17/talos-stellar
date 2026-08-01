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

## Signed SBOMs and build provenance

Every component release automatically attaches:

| Attachment | Pattern | Purpose |
|------------|---------|---------|
| CycloneDX SBOM | `talos-<component>-<tag>-<ts>.cdx.json` | Machine-readable dependency inventory (JSON, CycloneDX 1.6) |
| SPDX SBOM | `talos-<component>-<tag>-<ts>.spdx` | SPDX 2.3 tag-value inventory (SPDX license scanner compatible) |
| SLSA provenance | `talos-<component>-<tag>-<ts>.intoto.jsonl` | in-toto v1 statement + SLSA v1 predicate (level L3 aspiration) |
| Cosign keyless signatures | `<artifact>.<ext>.sig` + `<artifact>.<ext>.pem` for each attachment | OIDC-keyless Fulcio-issued signature + signing certificate |

Generation happens in [`.github/workflows/sbom-provenance.yml`](.github/workflows/sbom-provenance.yml), called as a reusable workflow from the release pipeline. Each SBOM is signed with OIDC keyless cosign (issuer `https://token.actions.githubusercontent.com`, workflow identity bound to `.github/workflows/(release-publish|sbom-provenance).yml`).

### Verification

Every release publishes a block of verification instructions in the release notes header. One-shot:

```bash
# Download all release assets for e.g. sdk-v1.2.3
gh release download sdk-v1.2.3 --dir artifacts

# Verify an artifact against its cosign signature + certificate
cosign verify-blob \
  --signature artifacts/@talos-protocol/sdk-1.2.3.tgz.sig \
  --certificate artifacts/@talos-protocol/sdk-1.2.3.tgz.pem \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/.+/\.github/workflows/(release-publish|sbom-provenance)\.yml@.*' \
  --insecure-ignore-tlog=true \
  artifacts/@talos-protocol/sdk-1.2.3.tgz
```

For a full audit, run [`.github/workflows/verify-artifacts.yml`](.github/workflows/verify-artifacts.yml) via `workflow_dispatch` with the release tag. It checks:

1. All artifact signatures verify against expected OIDC issuer/identity.
2. All SBOM signatures verify (CycloneDX + SPDX).
3. CycloneDX `bomFormat`/`specVersion`/`metadata.component` fields and SPDX required fields.
4. in-toto statement `_type`, predicate v1, and sha256 of each subject.
5. Outputs a SHA256 digest manifest for every attached file.

A scheduled nightly run re-verifies the most recent release so certificate-expiry or post-publication tampering events turn up without a human trigger.

### Configuration (devx subsystem)

The `src/area/devx` module exposes typed programmatic access used by the web dashboard and ops routes:

- `loadSbomConfig()` — feature flags, OIDC issuer expectations, retention, threshold rules (environment variable overridable, see `SBOM_*` in `config.ts`).
- `validateCycloneDxJson()`, `validateSpdxText()`, `validateIntotoStatement()` — strict parsers with deterministic `SbomFailureMode` error typing.
- `logSbomAudit()`, `logSbomFailure()`, `logSbomMetricSample()` — privacy-safe structured logs (signature blobs never recorded; keys matching `*sig*`, `*cert*`, `*secret*` are redacted via the existing `sanitizeForLogging` allowlist).
- `recordSbomMetric()`, `summarizeSbomMetrics()`, `validateSbomThresholds()` — bounded-memory metrics (percentile aggregation from samples, no unbounded arrays).

### Rollout, rollback, and troubleshooting

- **Rollout is gated at the workflow level**: forks without the reusable workflow file fall through without failures (reusable jobs are guarded by `if: needs.*.result != 'cancelled'` and the release pipeline tolerates `sbom-provenance.result ∈ {success, skipped, failure}`).
- **Disable for a component:** pass `SBOM_ENABLED=0` for runtime, or for CI, remove the component name from `sbom-provenance.yml`'s `detect-components` set. A clean rollback is reverting the PR that introduced this — no database migrations or on-disk state exist.
- **`cosign` install failures in CI**: fallback generators for CycloneDX / SPDX ship inside the workflow and produce valid-if-minimal SBOMs (marked in metadata via `tool.name = talos-*-fallback-generator`) instead of failing the release.
- **Re-run a partial release**: the existing release idempotency rules apply. `gh release create` is guarded against double-creation and artifacts are uploaded with `--clobber`, so a re-trigger after SBOM failure uploads what was missing the first pass without double-tagging.
- **Missing signatures on an already-published release**: run `verify-artifacts.yml` on-demand with `strict=true` to surface exactly which files, then manually re-run `sbom-provenance.yml` with `upload_release=true` against the tag.

### Limitations

- Version classification is per-commit-subject only; it does not inspect diffs, so a commit
  mislabeled with the wrong Conventional Commit type will bump the wrong severity.
- The four manifests are the source of truth. Manually editing a version number without going
  through the release PR will desync it from its git tag history — `plan`/`tag` will still work
  off whatever the manifest says, so keep manual edits out of the affected commits.
- `contracts`'s three crates must always share one version; a mismatch fails `plan`/`tag` loudly
  rather than guessing which one is right.
- Provenance subjects currently cover SBOMs and (for contracts) the WASM binaries; SDK and
  agent `.tgz`/`.whl` hashes are attested in *artifact* cosign signatures but not yet re-checked
  inside the in-toto subject list in every case — tracked as a follow-up to tighten the SLSA L3
  closure without breaking the idempotent-release contract.
- Rekor (`tlog-upload=false`) is disabled to avoid external dependency latency during the release
  hot path. Transparency-log inclusion is planned as a separate, non-blocking post-release job.
