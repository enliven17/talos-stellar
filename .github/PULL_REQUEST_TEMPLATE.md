## Summary

Prevent the reconciler state machine from expiring transactions or applying state
transitions when wall-clock or expiry dates are non-finite (`NaN` or
`Infinity`).

- Validate `expiresAt` and the supplied `now` date before wall-clock expiry checks.
- Return no transition for `PENDING` or `CONFIRMING` records when an expiry timestamp is invalid.
- Add focused coverage for non-finite expiry values and non-finite `now` values.

## Related Issues

Closes #1294

## Test Plan

- [x] Focused state-machine test:
  `pnpm --dir web exec vitest run tests/reconciler-state-machine.unit.test.ts`
  - Maintainer-checked PR merge revision: **64 tests passed**.
- [ ] Frozen workspace installation/build validation:
  `pnpm install --frozen-lockfile`
  - Blocked in the shared workspace dependency setup by
    `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` for
    `@sentry/opentelemetry@9.47.1(...)`.
  - Tracked by [#1502](https://github.com/enliven17/talos-stellar/issues/1502);
    this PR does not modify lockfiles or unrelated workspace dependencies.

No additional failure was investigated, so no base-versus-PR comparison is included.
