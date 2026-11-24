"""Scheduler run-policy helpers.

``check_should_run`` determines whether a periodic task should execute based
on its last-run timestamp and configured interval/schedule.  It is extracted
here so it can be unit-tested without starting the full scheduler loop.
"""

from __future__ import annotations

import math

from dataclasses import dataclass
from datetime import datetime, time, timezone
from typing import TYPE_CHECKING

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None  # type: ignore[assignment,misc]

if TYPE_CHECKING:
    from talos_agent.clock import ClockProtocol


MIN_RECURRING_INTERVAL_SECONDS = 1.0
MIN_RECURRING_TASK_INTERVAL_SECONDS = MIN_RECURRING_INTERVAL_SECONDS


def validate_recurring_task_interval(task_name: str, interval_seconds: float) -> None:
    """Validate a recurring task interval before it is used for a timer."""
    if (
        not isinstance(interval_seconds, (int, float))
        or isinstance(interval_seconds, bool)
        or interval_seconds < MIN_RECURRING_TASK_INTERVAL_SECONDS
    ):
        raise ValueError(
            f"Recurring task '{task_name}' interval must be at least "
            f"{MIN_RECURRING_TASK_INTERVAL_SECONDS:g} seconds"
        )


def check_should_run(
    now: datetime,
    last_run: datetime | None,
    interval_seconds: float | None = None,
    schedule_time: time | None = None,
    timezone_name: str | None = None,
    clock: "ClockProtocol | None" = None,
) -> bool:
    """Return ``True`` if the task should fire now.

    Two modes are supported:

    1. **Interval mode** (``interval_seconds`` given, no ``schedule_time``):
       fire when at least *interval_seconds* have elapsed since *last_run*.

    2. **Scheduled time mode** (``schedule_time`` given): fire when the
       current local time is at or past *schedule_time* AND the task hasn't
       already run at or after that scheduled slot today.  DST transitions
       are handled by detecting UTC-offset changes between ``now`` and
       ``last_run``: if they differ, the local clock crossed a DST boundary
       and we fire whenever the current local time has reached the scheduled
       slot.

    In both modes *last_run=None* always returns ``True`` (first-ever run).

    Parameters
    ----------
    now:
        Current time (timezone-aware).
    last_run:
        When the task last ran, or ``None`` if it never has.
    interval_seconds:
        Minimum seconds between runs (interval mode).
    schedule_time:
        Wall-clock time of day to run (scheduled-time mode).
    timezone_name:
        IANA timezone name used to evaluate *schedule_time*.  Defaults to UTC.
    clock:
        Unused; accepted for API symmetry with call sites that pass a clock.
    """
    if interval_seconds is not None:
        validate_recurring_task_interval("scheduler", interval_seconds)

    if last_run is None:
        return True

    # Ensure both datetimes are timezone-aware for arithmetic.
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=timezone.utc)

    if schedule_time is not None:
        tz = timezone.utc
        if timezone_name and ZoneInfo is not None:
            try:
                tz = ZoneInfo(timezone_name)
            except Exception:
                pass

        local_now = now.astimezone(tz)
        local_last = last_run.astimezone(tz)

        # Current local time hasn't reached the scheduled time yet — never fire.
        if local_now.time() < schedule_time:
            return False

        # Last run was on a strictly earlier local day — safe to fire.
        if local_now.date() > local_last.date():
            return True

        # DST boundary detection: if the UTC offset changed between last_run
        # and now, the local clock crossed a DST transition.  In this case
        # the local time representation of last_run can equal the schedule
        # time even though no real "scheduled run" occurred (spring-forward
        # gap) or occurred in a different UTC offset (fall-back overlap).
        # We fire whenever local_now >= schedule_time and there has been a
        # DST transition since the last run.
        if local_now.utcoffset() != local_last.utcoffset():
            return True

        # Same local day and same UTC offset (no DST transition): fire only
        # if the last run happened strictly before the scheduled slot.
        return local_last.time() < schedule_time

    if interval_seconds is not None:
        elapsed = (now - last_run).total_seconds()
        return elapsed >= interval_seconds

    # Fallback: always run.
    return True


def check_task_eligibility(
    now: datetime,
    task_name: str,
    db: object,
    talos_id: str | None = None,
) -> tuple[bool, datetime | None]:
    """Check whether a task is eligible to run according to its retry / failure state.

    Parameters
    ----------
    now:
        Current time (timezone-aware).
    task_name:
        Name of the task being checked.
    db:
        Database instance providing ``get_task_failure_history`` or ``get_retry_state``.
    talos_id:
        Optional agent identifier for agent-specific failure history.

    Returns
    -------
    tuple[bool, datetime | None]
        ``(is_eligible, next_eligible_at)``
        If currently backed off, returns ``(False, next_eligible_at)``.
        If eligible or no failure/backoff state exists, returns ``(True, next_eligible_at)``.
    """
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    next_eligible_at: datetime | None = None

    # Check failure history first if available
    if hasattr(db, "get_task_failure_history"):
        try:
            history = db.get_task_failure_history(talos_id=talos_id, task_name=task_name, limit=1)
            if history:
                next_eligible_at = history[0]["next_eligible_at"]
        except Exception:
            pass

    # Fall back to retry_state if failure history returned nothing or wasn't available
    if next_eligible_at is None and hasattr(db, "get_retry_state"):
        try:
            state = db.get_retry_state(task_name)
            if state:
                next_eligible_at = state.get("next_attempt_at")
        except Exception:
            pass

    if next_eligible_at is not None:
        if next_eligible_at.tzinfo is None:
            next_eligible_at = next_eligible_at.replace(tzinfo=timezone.utc)
        if now < next_eligible_at:
            return False, next_eligible_at

    return True, next_eligible_at

