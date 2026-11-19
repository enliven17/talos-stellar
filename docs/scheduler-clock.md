# Scheduler Clock Abstraction (Issue #186)

The injectable clock abstraction makes all time-dependent scheduler logic
deterministic in tests, eliminating wall-clock sleeps and flaky
timezone-sensitive assertions.

---

## Design

`src/talos_agent/clock.py` defines three objects:

| Class | Purpose |
|---|---|
| `ClockProtocol` | `typing.Protocol` with a single `now() -> datetime` method |
| `SystemClock` | Production clock — wraps `datetime.now(timezone.utc)` |
| `FakeClock` | Test clock — frozen at construction, advanced by `advance(seconds)` or `set(dt)` |

`FakeClock` enforces timezone-awareness: it raises `ValueError` for naive
datetimes on both construction and `set()`.

---

## DurableBackoff integration

`DurableBackoff` in `scheduler.py` accepts an optional `clock` parameter:

```python
bo = DurableBackoff(
    task_name="my_task",
    db=db,
    base_delay=10,
    clock=FakeClock(datetime(2026, 1, 1, tzinfo=timezone.utc)),  # test
)
```

When `clock=None` (default), `SystemClock()` is used — no change to
production behaviour.

The methods `wait_remaining()`, `failure()`, and `_persist()` all use
`self._clock.now()` instead of the formerly hardcoded
`datetime.now(timezone.utc)`.

---

## Test coverage (Issue #186 acceptance criteria)

`tests/test_scheduler_clock.py` — 38 tests across six categories:

### FakeClock API
- Initial time returned unchanged
- `advance()` moves time forward (including fractional seconds)
- `set()` jumps to an absolute point
- Naive datetimes rejected on construction and `set()`

### DurableBackoff + FakeClock
- `wait_remaining()` consults injected clock, not wall time
- Returns 0 when clock has advanced past next-attempt time
- Terminal flag set after `max_attempts` failures
- Terminal flag cleared on `success()`

### UTC boundary transitions
- Midnight crossing (23:59:58 → 00:00:01)
- New Year boundary (2025-12-31 23:59:59 → 2026-01-01 00:00:01)
- End-of-day and mid-month boundaries

### Configured timezone
- `America/New_York` UTC-5 offset correct (requires `zoneinfo`)
- `Asia/Tokyo` UTC+9 offset correct
- Two clocks at the same UTC instant compare equal across zones

### DST gap and overlap
- US Eastern spring-forward (2026-03-08): UTC arithmetic unambiguous
- US Eastern fall-back (2026-11-01): anchored in UTC to avoid fold ambiguity
- Europe/London spring-forward (2026-03-29)

All DST tests use `pytest.mark.skipif(not _HAS_ZONEINFO)` and pass on
Python 3.9+ (where `zoneinfo` is in stdlib).

### Missed-run policy
The `check_should_run(last_run, interval, clock)` helper mirrors the
`dividend_distribution_task` guard and is tested for:
- Task skipped when recently run (10 s into a 3600 s interval)
- Task runs when overdue (7200 s elapsed)
- Task runs when never run (`last_run=None`)
- Exactly-at-boundary case
- One-second-before-boundary case
- Midnight crossing
- Across a DST transition

---

## Local verification steps

```bash
cd packages/prime-agent

# Run all clock tests
uv run pytest tests/test_scheduler_clock.py -v

# Run full suite (must remain 320 passed)
uv run pytest tests/ -q

# Lint
uv run ruff check src tests
```

---

## Rollback

The clock abstraction is fully backward-compatible:
- `DurableBackoff(clock=None)` is identical to the previous behaviour.
- No environment variable or config change is needed.
- Removing `clock.py` would only break tests that import it explicitly.
