# Release evidence bundle

The release evidence generator creates a deterministic, self-contained JSON
bundle for offline review. It records the reviewed baseline revision, stable
check identifiers and statuses, and SHA-256 digests for each included artifact.
Artifact bytes are embedded as base64 so reviewers can inspect them without
access to the originating machine or network.

Run it from the repository root:

```bash
pnpm release:evidence -- --baseline 56e263152a911f0ec8e4b3b0988d9366db08641d \
  --required-check doctor \
  --required-check web-unit \
  --required-check contracts \
  --check doctor=passed \
  --check web-unit=passed \
  --artifact reports/doctor.json \
  --artifact reports/web-unit.txt \
  --output dist/release-evidence.json
```

A required check without a supplied result is included with status `not-run`.
Supported explicit statuses are `passed`, `failed`, and `not-run`. Check IDs
are stable lowercase identifiers; results and artifacts are sorted before
serialization. The output deliberately contains no timestamp, hostname,
absolute path, or ambient process-environment values, so identical inputs
produce byte-identical JSON.

## Privacy and size limits

The generator fails closed rather than attempting to redact artifacts. It
refuses environment files, secret/key paths, symlinks, files outside the
repository, non-regular files, and content matching common credential or
private-key patterns. Do not pass production logs or unreviewed environment
dumps. Use synthetic fixtures and sanitized check output only.

Each artifact is limited to 2 MiB and all artifacts together are limited to
10 MiB. The bundle includes each artifact's repository-relative path, byte
length, SHA-256 digest, and base64 content. Reviewers can independently
recompute the digest after decoding the content.

Run the focused tests with:

```bash
pnpm release:evidence:test
```

The generator is local-only: it does not contact services, inspect Stellar
accounts, sign transactions, or move funds.
