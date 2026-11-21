## Summary

Provide a brief description of the changes, background context, and what these changes accomplish.

Include whether this change updates shared request parsing, config defaults, or any API error contract.

## Related Issues

Closes #N (Replace N with the issue number, e.g. Closes #1)

## Test Plan

Detail the steps you took to test these changes.

- [ ] Automated tests run (e.g. `cargo test`, `uv run pytest`, `pnpm test:e2e`)
- [ ] Focused regression tests for request parsing / body limits pass
- [ ] Manual verification steps performed:
  - 1. ...
  - 2. ...
- [ ] Relevant docs updated when setup, environment variables, or workflows changed

## Visual Changes (if applicable)

For any user interface changes, please add screenshots or screen recordings showing:

- Before
- After

## Checklist

- [ ] I have read the [CONTRIBUTING.md](../CONTRIBUTING.md) guide.
- [ ] My code follows the style guidelines of this project.
- [ ] I have updated `.env.example` files and documentation if I changed environment variables.
- [ ] I have documented any config defaults or API error contracts that changed.
- [ ] I have commented my code, particularly in hard-to-understand areas.
- [ ] I have made corresponding changes to the documentation.
- [ ] I have added tests that prove my fix is effective or that my feature works.
- [ ] I have verified the request-body guard rejects oversize requests before JSON parsing.
- [ ] My changes generate no new warnings or errors.
- [ ] New and existing unit tests pass locally with my changes.
