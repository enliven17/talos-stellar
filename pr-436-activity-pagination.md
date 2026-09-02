# 436 test(web): add pagination property tests for the activity API

## Summary

Add deterministic pagination coverage for the global activity feed so cursor-based traversal is verified without requiring a live database or service.

## What changed

- Added focused pagination tests for `GET /api/activity`
- Covered cursor traversal across multiple deterministic fixture pages
- Verified tied timestamps follow the documented ordering rules
- Verified empty pages return `transactions: []` and `nextCursor: null`
- Verified malformed cursors return the documented client error
- Verified the final page returns a null cursor and no duplicate or skipped records

## Acceptance criteria

- No records are duplicated or skipped across pages
- Concatenated pages match the expected ordered fixtures exactly once
- Invalid cursors return the documented client error
- Tests do not require a live database or service

## Local validation

```bash
cd web && pnpm vitest run tests/activity.test.ts tests/activity-pagination.test.ts
```

## Notes

These tests exercise the activity API contract directly and ensure the cursor semantics remain stable across deterministic fixture pages, including edge cases like timestamp ties and the terminal null cursor.
