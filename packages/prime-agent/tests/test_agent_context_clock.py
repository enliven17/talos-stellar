"""Tests for the injectable clock in AgentContext (Issue #877)."""

from __future__ import annotations

from datetime import datetime, timezone

from talos_agent.agent.context import AgentContext
from talos_agent.clock import FakeClock


def _utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def test_current_time_uses_injected_clock(mock_db):
    clock = FakeClock(_utc(2026, 1, 2, 3, 4))

    context = AgentContext.from_db(mock_db, {}, clock=clock)

    assert context.current_time == "2026-01-02 03:04 UTC"
    assert "Current time: 2026-01-02 03:04 UTC" in context.to_context_block()


def test_injected_clock_is_deterministic_across_advance(mock_db):
    clock = FakeClock(_utc(2026, 6, 30, 23, 59))

    first = AgentContext.from_db(mock_db, {}, clock=clock)
    clock.advance(120)
    second = AgentContext.from_db(mock_db, {}, clock=clock)

    assert first.current_time == "2026-06-30 23:59 UTC"
    assert second.current_time == "2026-07-01 00:01 UTC"


def test_from_db_defaults_to_system_clock(mock_db, monkeypatch):
    fixed = _utc(2026, 9, 15, 12, 30)

    class _FixedSystemClock:
        def now(self) -> datetime:
            return fixed

    monkeypatch.setattr(
        "talos_agent.agent.context.SystemClock",
        lambda: _FixedSystemClock(),
    )

    context = AgentContext.from_db(mock_db, {})

    assert context.current_time == "2026-09-15 12:30 UTC"
