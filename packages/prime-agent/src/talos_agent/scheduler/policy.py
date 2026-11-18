"""Scheduler run-policy helpers.

``check_should_run`` determines whether a periodic task should execute based
on its last-run timestamp and configured interval/schedule.  It is extracted
here so it can be unit-tested without starting the full scheduler loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timezone
from typing import TYPE_CHECKING

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None  # type: ignore[assignment,misc]

if TYPE_CHECKING:
    from talos_agent.clock import ClockProtocol


@dataclass(frozen=True)
class SchedulerConsistencyReport:
    """Read-only comparison of persisted scheduler identities and live tasks."""

    matched: tuple[str, ...]
    orphaned_durable: tuple[str, ...]
    untracked_active: tuple[str, ...]
    uncertain: tuple[str, ...]
    recovery_plan: tuple[str, ...]


def build_consistency_report(
    durable_execution_ids: set[str] | frozenset[str] | list[str] | tuple[str, ...],
    active_task_ids: set[str] | frozenset[str] | list[str] | tuple[str, ...],
    *,
    durable_source_available: bool = True,
    active_source_available: bool = True,
) -> SchedulerConsistencyReport:
    """Compare durable execution identities with active asyncio task names.

    This function never mutates state or requeues work. If either observation
    source is unavailable, the affected side is reported as uncertain instead
    of being treated as orphaned, preventing an unsafe recovery decision.
    """
    durable = set(durable_execution_ids)
    active = set(active_task_ids)
    matched = tuple(sorted(durable & active))
    orphaned = tuple(sorted(durable - active)) if durable_source_available and active_source_available else ()
    untracked = tuple(sorted(active - durable)) if durable_source_available and active_source_available else ()
    uncertain: list[str] = []
    if not durable_source_available:
        uncertain.append("durable execution store unavailable")
    if not active_source_available:
        uncertain.append("active asyncio task snapshot unavailable")

    plan = [
        "Inspect orphaned durable executions and verify lease ownership before recovery.",
        "Do not requeue or cancel work from this report; an operator must confirm the state.",
    ]
    if orphaned:
        plan.insert(0, f"Review {len(orphaned)} durable execution(s) with no matching active task.")
    if uncertain:
        plan.insert(0, "Retry the observation before making a recovery decision.")

    return SchedulerConsistencyReport(
        matched=matched,
        orphaned_durable=orphaned,
        untracked_active=untracked,
        uncertain=tuple(uncertain),
        recovery_plan=tuple(plan),
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
