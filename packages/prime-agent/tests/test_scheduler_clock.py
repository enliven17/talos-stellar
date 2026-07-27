"""Tests for Issue #186: injectable clock abstraction and timezone/DST boundaries.

Covers:
- FakeClock: basic API, timezone-aware enforcement, advance, set
- DurableBackoff: clock injection, wait_remaining, terminal state
- UTC midnight and year-boundary transitions
- Configured timezone (New York, Tokyo) arithmetic
- DST gap and overlap (US Eastern, Europe/London) — skipped if zoneinfo absent
- Missed-run policy (check_should_run helper mirrors scheduler logic)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

try:
    from zoneinfo import ZoneInfo

    _HAS_ZONEINFO = True
except ImportError:
    ZoneInfo = None  # type: ignore[assignment,misc]
    _HAS_ZONEINFO = False

from talos_agent.clock import FakeClock, SystemClock

# ── Helpers ───────────────────────────────────────────────────────────────────


def _utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


def _make_backoff_db():
    """Minimal DB mock for DurableBackoff."""
    db = MagicMock()
    db.get_retry_state = MagicMock(return_value=None)
    db.upsert_retry_state = MagicMock()
    db.clear_retry_state = MagicMock()
    return db


# ── Missed-run policy helper (mirrors scheduler dividend_distribution_task) ───


def check_should_run(
    last_run: datetime | None,
    interval: float,
    clock: FakeClock,
) -> tuple[bool, float]:
    """Return (should_run, remaining_seconds).

    This mirrors the logic inside ``dividend_distribution_task`` in
    scheduler.py so we can test the policy without spinning up the full
    scheduler.
    """
    if last_run is None:
        return True, 0.0
    elapsed = (clock.now() - last_run).total_seconds()
    remaining = interval - elapsed
    if remaining > 0:
        return False, remaining
    return True, 0.0


# ── FakeClock — basic API ─────────────────────────────────────────────────────


def test_fake_clock_returns_initial_time():
    dt = _utc(2026, 1, 1, 12, 0, 0)
    clock = FakeClock(dt)
    assert clock.now() == dt


def test_fake_clock_advance_moves_forward():
    dt = _utc(2026, 1, 1, 12, 0, 0)
    clock = FakeClock(dt)
    clock.advance(30)
    assert clock.now() == _utc(2026, 1, 1, 12, 0, 30)


def test_fake_clock_advance_fractional_seconds():
    dt = _utc(2026, 1, 1, 0, 0, 0)
    clock = FakeClock(dt)
    clock.advance(0.5)
    expected = dt + timedelta(seconds=0.5)
    assert clock.now() == expected


def test_fake_clock_advance_large_jump():
    dt = _utc(2026, 1, 1, 0, 0, 0)
    clock = FakeClock(dt)
    clock.advance(3600 * 24)  # 1 day
    assert clock.now() == _utc(2026, 1, 2, 0, 0, 0)


def test_fake_clock_set_updates_current():
    dt = _utc(2026, 1, 1, 12, 0, 0)
    clock = FakeClock(dt)
    new_dt = _utc(2026, 6, 15, 8, 30, 0)
    clock.set(new_dt)
    assert clock.now() == new_dt


def test_fake_clock_set_rejects_naive_datetime():
    dt = _utc(2026, 1, 1)
    clock = FakeClock(dt)
    with pytest.raises(ValueError, match="timezone-aware"):
        clock.set(datetime(2026, 6, 1, 0, 0, 0))  # naive


def test_fake_clock_rejects_naive_initial():
    with pytest.raises(ValueError, match="timezone-aware"):
        FakeClock(datetime(2026, 1, 1, 0, 0, 0))  # naive


def test_fake_clock_monotonic_after_multiple_advances():
    clock = FakeClock(_utc(2026, 1, 1))
    for _ in range(10):
        before = clock.now()
        clock.advance(1)
        assert clock.now() > before


def test_system_clock_returns_utc():
    sc = SystemClock()
    now = sc.now()
    assert now.tzinfo is not None


# ── DurableBackoff with FakeClock ─────────────────────────────────────────────


def test_durable_backoff_wait_remaining_uses_injected_clock():
    """wait_remaining() must use the injected clock, not wall clock."""
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    initial_time = _utc(2026, 1, 1, 0, 0, 0)
    clock = FakeClock(initial_time)

    bo = DurableBackoff(
        task_name="test_task",
        db=db,
        base_delay=10,
        initial_backoff=2.0,
        max_backoff=300.0,
        clock=clock,
    )
    bo.failure()  # records next_attempt_at = initial_time + delay

    # With the clock frozen at initial_time, wait_remaining > 0.
    remaining_before = bo.wait_remaining()
    assert remaining_before > 0

    # Advance clock past the next attempt time.
    clock.advance(remaining_before + 1)
    assert bo.wait_remaining() == 0.0


def test_durable_backoff_zero_wait_when_overdue():
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    clock = FakeClock(_utc(2026, 1, 1, 0, 0, 0))
    bo = DurableBackoff(task_name="t", db=db, base_delay=5, clock=clock)

    bo.failure()
    # Jump far into the future.
    clock.advance(10_000)
    assert bo.wait_remaining() == 0.0


def test_durable_backoff_terminal_after_max_attempts():
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    clock = FakeClock(_utc(2026, 1, 1))
    bo = DurableBackoff(task_name="t", db=db, base_delay=1, max_attempts=3, clock=clock)

    assert not bo.is_terminal
    bo.failure()
    assert not bo.is_terminal
    bo.failure()
    assert not bo.is_terminal
    bo.failure()
    assert bo.is_terminal


def test_durable_backoff_success_resets_terminal():
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    clock = FakeClock(_utc(2026, 1, 1))
    bo = DurableBackoff(task_name="t", db=db, base_delay=1, max_attempts=2, clock=clock)

    bo.failure()
    bo.failure()
    assert bo.is_terminal

    bo.success()
    assert not bo.is_terminal
    assert bo.fail_count == 0


def test_durable_backoff_failure_increments_fail_count():
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    clock = FakeClock(_utc(2026, 1, 1))
    bo = DurableBackoff(task_name="t", db=db, base_delay=1, clock=clock)

    bo.failure()
    assert bo.fail_count == 1
    bo.failure()
    assert bo.fail_count == 2


def test_durable_backoff_success_clears_fail_count():
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    clock = FakeClock(_utc(2026, 1, 1))
    bo = DurableBackoff(task_name="t", db=db, base_delay=1, clock=clock)

    bo.failure()
    bo.failure()
    bo.success()
    assert bo.fail_count == 0


def test_durable_backoff_uses_clock_for_next_attempt_at():
    """failure() must set next_attempt_at = clock.now() + delay, not wall time."""
    from talos_agent.scheduler import DurableBackoff

    db = _make_backoff_db()
    fixed_time = _utc(2026, 6, 1, 12, 0, 0)
    clock = FakeClock(fixed_time)
    bo = DurableBackoff(task_name="t", db=db, base_delay=1, initial_backoff=10, jitter=0, clock=clock)

    bo.failure()  # fail_count becomes 1 → delay = initial_backoff * 2^0 = 10
    # next_attempt_at should be fixed_time + ~10s (no jitter)
    # wait_remaining at frozen clock ≈ 10s
    assert 8 < bo.wait_remaining() <= 12


# ── UTC boundary transitions ──────────────────────────────────────────────────


def test_utc_midnight_transition():
    """Advancing across midnight must give the correct next-day timestamp."""
    clock = FakeClock(_utc(2026, 1, 1, 23, 59, 58))
    clock.advance(3)  # crosses midnight
    assert clock.now() == _utc(2026, 1, 2, 0, 0, 1)


def test_utc_new_year_boundary():
    clock = FakeClock(_utc(2025, 12, 31, 23, 59, 59))
    clock.advance(2)
    assert clock.now() == _utc(2026, 1, 1, 0, 0, 1)


def test_utc_leap_second_boundary():
    """No leap-second handling in Python stdlib; verify simple arithmetic."""
    clock = FakeClock(_utc(2026, 6, 30, 23, 59, 59))
    clock.advance(1)
    assert clock.now() == _utc(2026, 7, 1, 0, 0, 0)


def test_utc_end_of_day():
    clock = FakeClock(_utc(2026, 3, 15, 23, 59, 0))
    clock.advance(60)
    assert clock.now() == _utc(2026, 3, 16, 0, 0, 0)


# ── Configured timezone boundary tests ───────────────────────────────────────


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_timezone_aware_clock_new_york():
    """FakeClock with America/New_York correctly reflects UTC offset."""
    ny_tz = ZoneInfo("America/New_York")
    # 2026-01-15 12:00 EST = UTC-5 → 17:00 UTC
    dt_ny = datetime(2026, 1, 15, 12, 0, 0, tzinfo=ny_tz)
    clock = FakeClock(dt_ny)
    assert clock.now().utcoffset() == timedelta(hours=-5)
    # Converting to UTC should give 17:00.
    assert clock.now().astimezone(timezone.utc).hour == 17


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_timezone_aware_clock_tokyo():
    """FakeClock with Asia/Tokyo (UTC+9) reflects correct offset."""
    tokyo_tz = ZoneInfo("Asia/Tokyo")
    dt_tokyo = datetime(2026, 1, 15, 9, 0, 0, tzinfo=tokyo_tz)
    clock = FakeClock(dt_tokyo)
    assert clock.now().utcoffset() == timedelta(hours=9)
    # 09:00 JST = 00:00 UTC
    assert clock.now().astimezone(timezone.utc).hour == 0


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_timezone_comparison_utc_vs_local():
    """Two FakeClocks at the same UTC instant compare equal."""
    ny_tz = ZoneInfo("America/New_York")
    # Same UTC moment expressed in different zones.
    dt_utc = _utc(2026, 1, 15, 17, 0, 0)
    dt_ny = datetime(2026, 1, 15, 12, 0, 0, tzinfo=ny_tz)  # EST = UTC-5

    clock_utc = FakeClock(dt_utc)
    clock_ny = FakeClock(dt_ny)

    # Difference should be zero.
    diff = (clock_utc.now() - clock_ny.now().astimezone(timezone.utc)).total_seconds()
    assert abs(diff) < 1


# ── DST gap and overlap tests ─────────────────────────────────────────────────


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_dst_spring_forward_gap_us_eastern():
    """2026-03-08: US Eastern clocks spring forward at 02:00 → 03:00.

    At 01:59:59 EST (UTC-5) we add 2 seconds.  The UTC result must be
    correct regardless of the local clock gap.
    """
    eastern = ZoneInfo("America/New_York")
    # 2026-03-08 01:59:59 EST = UTC-5 → 06:59:59 UTC
    dt_before = datetime(2026, 3, 8, 1, 59, 59, tzinfo=eastern)
    clock = FakeClock(dt_before)

    utc_before = dt_before.astimezone(timezone.utc)
    clock.advance(2)

    utc_after = clock.now().astimezone(timezone.utc)
    expected_utc_after = utc_before + timedelta(seconds=2)
    # Allow 1s tolerance for any DST fold resolution.
    diff = abs((utc_after - expected_utc_after).total_seconds())
    assert diff <= 1


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_dst_fall_back_overlap_us_eastern():
    """2026-11-01: US Eastern clocks fall back at 02:00 → 01:00 (EDT→EST).

    The ambiguous local time 01:59:59 appears twice.  We anchor the test in
    UTC so that timedelta arithmetic is unambiguous.  fold=0 (first occurrence,
    EDT = UTC-4) means 01:59:59 EDT = 05:59:59 UTC.
    """
    eastern = ZoneInfo("America/New_York")
    # Construct via UTC to avoid fold ambiguity in timedelta arithmetic.
    # 2026-11-01 05:59:59 UTC = 01:59:59 EDT (first occurrence, fold=0)
    dt_before_utc = datetime(2026, 11, 1, 5, 59, 59, tzinfo=timezone.utc)
    clock = FakeClock(dt_before_utc)

    clock.advance(2)

    utc_after = clock.now()
    expected_utc = dt_before_utc + timedelta(seconds=2)
    diff = abs((utc_after - expected_utc).total_seconds())
    assert diff <= 1

    # Also verify the local-time representation is sane.
    local_after = utc_after.astimezone(eastern)
    # After 06:00:01 UTC it's 02:00:01 EDT but clocks fall back, so local shows 01:00:01 EST.
    # The key invariant: UTC arithmetic is preserved.
    assert local_after.utcoffset() is not None


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_dst_spring_forward_europe_london():
    """2026-03-29: Europe/London clocks spring forward at 01:00 → 02:00 (GMT→BST).

    At 00:59:59 GMT (UTC+0) we advance 2s; UTC arithmetic is unambiguous.
    """
    london = ZoneInfo("Europe/London")
    dt_before = datetime(2026, 3, 29, 0, 59, 59, tzinfo=london)
    clock = FakeClock(dt_before)

    utc_before = dt_before.astimezone(timezone.utc)
    clock.advance(2)

    utc_after = clock.now().astimezone(timezone.utc)
    expected_utc = utc_before + timedelta(seconds=2)
    diff = abs((utc_after - expected_utc).total_seconds())
    assert diff <= 1


# ── Missed-run policy tests ───────────────────────────────────────────────────


def test_dividend_task_skips_when_recently_run():
    """10 seconds have elapsed of a 3600-second interval; task should wait."""
    clock = FakeClock(_utc(2026, 1, 1, 1, 0, 10))
    last_run = _utc(2026, 1, 1, 1, 0, 0)  # 10s ago
    should_run, remaining = check_should_run(last_run, 3600, clock)
    assert not should_run
    assert abs(remaining - 3590) < 1


def test_dividend_task_runs_when_overdue():
    """7200s elapsed of a 3600-second interval; task should run."""
    clock = FakeClock(_utc(2026, 1, 1, 3, 0, 0))
    last_run = _utc(2026, 1, 1, 1, 0, 0)  # 7200s ago
    should_run, remaining = check_should_run(last_run, 3600, clock)
    assert should_run
    assert remaining == 0.0


def test_dividend_task_runs_when_never_run():
    """No prior run → task should run immediately."""
    clock = FakeClock(_utc(2026, 1, 1, 0, 0, 0))
    should_run, remaining = check_should_run(None, 3600, clock)
    assert should_run
    assert remaining == 0.0


def test_dividend_task_exactly_at_boundary():
    """Exactly at the interval boundary: remaining == 0, should run."""
    clock = FakeClock(_utc(2026, 1, 1, 1, 0, 0))
    last_run = _utc(2026, 1, 1, 0, 0, 0)  # exactly 3600s ago
    should_run, remaining = check_should_run(last_run, 3600, clock)
    assert should_run


def test_dividend_task_one_second_before_boundary():
    """One second before the boundary: should NOT run yet."""
    clock = FakeClock(_utc(2026, 1, 1, 0, 59, 59))
    last_run = _utc(2026, 1, 1, 0, 0, 0)  # 3599s ago
    should_run, remaining = check_should_run(last_run, 3600, clock)
    assert not should_run
    assert abs(remaining - 1) < 0.01


def test_missed_run_across_midnight():
    """A task that last ran before midnight should still be correctly overdue."""
    clock = FakeClock(_utc(2026, 1, 2, 2, 0, 0))   # 02:00 next day
    last_run = _utc(2026, 1, 1, 23, 0, 0)           # 23:00 previous day (3h ago)
    should_run, _ = check_should_run(last_run, 3600, clock)
    assert should_run  # 3h > 1h interval


@pytest.mark.skipif(not _HAS_ZONEINFO, reason="zoneinfo not available")
def test_missed_run_policy_across_dst_boundary():
    """Missed-run policy works correctly across a DST transition."""
    eastern = ZoneInfo("America/New_York")
    # Last run was at 01:30 EST (before spring-forward), clock is now 03:30 EDT.
    # EST is UTC-5, EDT is UTC-4.
    last_run_est = datetime(2026, 3, 8, 1, 30, 0, tzinfo=eastern)  # 06:30 UTC
    clock_time = datetime(2026, 3, 8, 3, 30, 0, tzinfo=eastern)    # 07:30 UTC (after spring-forward)
    clock = FakeClock(clock_time)

    # Elapsed UTC time = 07:30 - 06:30 = 60 minutes = 3600s
    last_run_utc = last_run_est.astimezone(timezone.utc)
    elapsed = (clock.now().astimezone(timezone.utc) - last_run_utc).total_seconds()
    assert abs(elapsed - 3600) <= 60  # within 60s of 1 hour

    should_run, _ = check_should_run(last_run_utc, 3600, clock)
    assert should_run
