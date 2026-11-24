# Compatibility manifest

`compatibility.json` records the toolchain and schema versions this repository
supports. `scripts/check-compatibility-manifest.mjs` compares the manifest with
the files that declare each version, so drift fails CI. The
`compatibility-manifest` job in `.github/workflows/ci.yml` runs both the check
and its tests.

Run the checks locally from the repository root:

```bash
pnpm run compat:check
pnpm run test:compat
```

## What is verified

| Manifest field | Source of truth |
| --- | --- |
| `toolchains.node.minimum` | `package.json` → `engines.node` |
| `toolchains.node.contributorMinimum` | `scripts/doctor.mjs` → `MINIMUMS.node` |
| `toolchains.pnpm.minimum` | `scripts/doctor.mjs` → `MINIMUMS.pnpm` |
| `toolchains.python.minimum` | `packages/prime-agent/pyproject.toml` → `requires-python` |
| `toolchains.python.contributorMinimum` | `scripts/doctor.mjs` → `MINIMUMS.python` |
| `toolchains.rust.channel` | `contracts-ci.yml` and `.devcontainer/Dockerfile` |
| `toolchains.rust.edition` | every `contracts/*/Cargo.toml` `[package]` |
| `toolchains.rust.wasmTarget` | `contracts-ci.yml` and `.devcontainer/Dockerfile` |
| `schemas.events.version` | `packages/sdk/src/events.ts` → `TALOS_EVENT_SCHEMA_VERSION` |
| `schemas.logs.version` | `web/src/lib/log-schema.ts` → `LOG_SCHEMA_VERSION` |
| `schemas.databaseMigrations.version` | latest tag in `web/drizzle/meta/_journal.json` |

The checker fails closed: a missing source file or an unparsable version is an
error, not a skipped check.

## Machine-readable doctor findings

Run `pnpm doctor:json` to emit a JSON object with the stable `exitCode` and a
`findings` array. Each finding includes a stable `id` and `code`, severity,
expected requirement, observed version or target state (or `null` when
unavailable), and a human-readable message. Unrecognized tool output is never
echoed into the report. Required-tool failures retain exit code `1`;
optional-tool findings do not change the exit code.

## Adding support for a new version

1. Change the source of truth first. For example, raise `engines.node` in
   `package.json`, `requires-python` in the prime agent `pyproject.toml`, a
   contract's `edition`, the Rust toolchain in CI and the devcontainer, a
   schema constant, or add a Drizzle migration.
2. Update the matching value in `compatibility.json`.
3. Run `pnpm run compat:check` and confirm every line reports `ok`.
4. If you add a new field or a new source file, extend
   `scripts/check-compatibility-manifest.test.mjs` with a passing fixture and a
   drift case.
5. Commit the source change, `compatibility.json`, and any test updates in the
   same pull request.

Do not edit the manifest on its own to silence a failure. The checker reads the
source files, and CI will still fail until they agree.
