# feat(sdk): publish CJS and ESM export-map checks

Closes #582

## Summary

Add automated checks that the published `@talos-protocol/sdk` export map
actually resolves for both CJS (`require`) and ESM (`import`) consumers, instead
of relying on the manifest looking correct by inspection. A single validator
drives both a build-free unit suite and a post-build runtime/publish smoke
check, so contributors and operators get the same verdict locally and in CI.

## What changed

- **`packages/sdk/scripts/export-map-lib.mjs`** (new) — pure validation rules
  for `exports["."]` and the `files` allow-list. No filesystem or `process`
  access, so it runs against the real manifest and synthetic fixtures alike.
- **`packages/sdk/scripts/smoke-export-map.mjs`** (new, `compat:exports`) —
  post-build check that:
  - validates the manifest and fails on the first missing/malformed target;
  - confirms every declared target exists on disk and is non-empty;
  - resolves the package through Node's real exports map (self-reference) and
    asserts `require` and `import` land on the declared CJS/ESM targets;
  - asserts the CJS and ESM builds expose the same public surface;
  - confirms every target is present in the publish tarball via
    `npm pack --dry-run --json`.
- **`packages/sdk/tests/export-map.test.ts`** (new) — 30 build-free tests:
  positive coverage of the shipped manifest, negative coverage for each failure
  mode, boundary cases (optional `browser`, nested conditions, unknown
  conditions), and regression guards (no silent fall back to a single entry
  point; diagnostics never contain host paths).
- **`packages/sdk/package.json`** — add `compat:exports` and run it first in the
  `compat` aggregate.
- **`.github/workflows/sdk-compatibility.yml`** — new `export-map` job
  (Node 18/20/22) that runs the check against the built artifacts.
- **`packages/sdk/README.md`** — document the conditions and how to verify them.

## Acceptance criteria

- The behavior is available through the existing tooling (`npm run compat:exports`,
  `npm test`) without changing any public API or the published `exports` map.
- Failures are explicit and privacy-safe: messages contain only condition names
  and package-relative paths — never secrets, tokens, or host paths.
- Compatibility handling is documented in the README; no migrations are needed.

## Compatibility, migration, and operational impact

- **No runtime or API change.** The published `exports` map, entry points, and
  public surface are untouched; existing callers are unaffected.
- **No migration required.** The new check only *reads* the manifest and the
  built output.
- **Operational impact:** CI gains one job. It fails fast with a specific reason
  when a condition is missing, a target escapes the package root, a target is
  dropped from the `files` allow-list, or the CJS and ESM surfaces diverge.
- The check reports two non-blocking advisories about the current manifest:
  `browser` is declared after `import`/`require` (so condition-order-sensitive
  resolvers select the ESM build) and `types` is not listed first. Both are
  documented rather than silently "fixed", since reordering `browser` ahead of
  `import` would hand bundlers the IIFE global bundle instead of a module.

## Local validation

```bash
cd packages/sdk
npm run build
npm run compat:exports   # export map: ALL CHECKS PASSED
npm test                 # 30/30 new tests pass
npm run build:esm        # typecheck clean
```

## Notes

`packages/sdk/tests/chaos.integration.test.ts` (2) and
`packages/sdk/tests/compatibility.test.ts` (1) have failures on `main` that are
unrelated to this change (chaos-injection timing and client JSON serialization).
