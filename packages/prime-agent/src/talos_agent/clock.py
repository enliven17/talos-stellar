"""Injectable clock abstraction for deterministic testing.

Provides ClockProtocol, SystemClock, and FakeClock so scheduler
components that depend on the current time can be tested without
wall-clock sleeps.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Protocol, runtime_checkable


@runtime_checkable
class ClockProtocol(Protocol):
    """Minimal interface for a time source."""

    def now(self) -> datetime:
        """Return the current time as a timezone-aware datetime."""
        ...


class SystemClock:
    """Live clock — always returns ``datetime.now(timezone.utc)``."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class FakeClock:
    """Injectable deterministic clock for tests.

    Parameters
    ----------
    initial:
        Starting timestamp.  Must be timezone-aware; raises
        ``ValueError`` if a naive datetime is supplied.

    Usage::

        clock = FakeClock(datetime(2026, 1, 1, tzinfo=timezone.utc))
        clock.advance(3600)   # move forward 1 hour
        clock.set(some_dt)    # jump to an absolute point
    """

    def __init__(self, initial: datetime) -> None:
        if initial.tzinfo is None:
            raise ValueError(
                "FakeClock requires a timezone-aware datetime; "
                "got a naive datetime instead."
            )
        self._current: datetime = initial

    # ── ClockProtocol ─────────────────────────────────────────────────────

    def now(self) -> datetime:
        """Return the current fake time."""
        return self._current

    # ── Test helpers ──────────────────────────────────────────────────────

    def advance(self, seconds: float) -> None:
        """Move the clock forward by *seconds* (may be fractional)."""
        self._current += timedelta(seconds=seconds)

    def set(self, dt: datetime) -> None:
        """Jump the clock to an absolute datetime.

        Raises ``ValueError`` if *dt* is naive.
        """
        if dt.tzinfo is None:
            raise ValueError("FakeClock.set() requires a timezone-aware datetime.")
        self._current = dt
