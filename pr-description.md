## Summary

Add CI coverage for `packages/prime-agent` and implement a Telegram publishing adapter for the Talos Prime Agent.

This includes:
- A new GitHub Actions workflow that runs lint and tests on PRs and main branch pushes affecting `packages/prime-agent/**`.
- A Telegram adapter that posts messages and replies through the Telegram Bot API.
- Unit tests covering Telegram posting and reply behavior.
- Dependency and configuration updates to support the new adapter and CI workflow.

## Related Issues

Closes #N

## Test Plan

- [x] Automated tests run: `uv run pytest tests/test_telegram_adapter.py`
- [x] Local lint run: `uv run ruff check src/ tests/`
- [x] README badge updated to point at `enliven17/talos-stellar`
- [x] Manual verification steps performed:
  - 1. Verified the Telegram adapter payload and reply handling in mocked tests.
  - 2. Confirmed the new CI workflow file is present and configured for the correct path filters.
  - 3. Confirmed the package-wide lint command now passes for `src/` and `tests/`.

## Visual Changes (if applicable)

No user interface changes were made.

## Checklist

- [ ] I have read the [CONTRIBUTING.md](CONTRIBUTING.md) guide.
- [x] My code follows the style guidelines of this project.
- [x] I have commented my code, particularly in hard-to-understand areas.
- [x] I have made corresponding changes to the documentation.
- [x] My changes generate no new warnings or errors.
- [x] I have added tests that prove my fix is effective or that my feature works.
- [x] New and existing unit tests pass locally with my changes.
