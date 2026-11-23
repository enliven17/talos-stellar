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


MissedRunPolicy = Literal["skip", "coalesce", "catch_up"]


@dataclass(frozen=True)
class IntervalRunDecision:
    """Bounded execution plan for a recurring interval task."""

    policy: MissedRunPolicy
    due_runs: int
    runs_to_execute: int
    lateness_seconds: float
    next_run_in_seconds: float


def plan_interval_runs(
    now: datetime,
    last_run: datetime | None,
    interval_seconds: float,
    *,
    policy: MissedRunPolicy = "coalesce",
    max_catch_up_runs: int = 3,
) -> IntervalRunDecision:
    """Plan interval work and report lateness relative to its earliest due slot.

    ``skip`` executes one due run normally, but drops all work when multiple
    interval slots accumulated. ``coalesce`` executes once regardless of
    backlog. ``catch_up`` executes at most ``max_catch_up_runs``.
    """
    if policy not in ("skip", "coalesce", "catch_up"):
        raise ValueError("policy must be 'skip', 'coalesce', or 'catch_up'")
    try:
        interval = float(interval_seconds)
    except (OverflowError, TypeError, ValueError):
        interval = math.nan
    if (
        isinstance(interval_seconds, bool)
        or not isinstance(interval_seconds, (int, float))
        or not math.isfinite(interval)
        or interval <= 0
    ):
        raise ValueError("interval_seconds must be a finite number greater than 0")
    if (
        isinstance(max_catch_up_runs, bool)
        or not isinstance(max_catch_up_runs, int)
        or not 1 <= max_catch_up_runs <= 10
    ):
        raise ValueError("max_catch_up_runs must be an integer between 1 and 10")

    if last_run is None:
        return IntervalRunDecision(policy, 1, 1, 0.0, 0.0)

    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=timezone.utc)

    elapsed = (now - last_run).total_seconds()
    if elapsed < interval:
        return IntervalRunDecision(
            policy,
            0,
            0,
            0.0,
            interval - max(elapsed, 0.0),
        )

    due_runs = Fraction.from_float(elapsed) // Fraction.from_float(interval)
    lateness_seconds = max(elapsed - interval, 0.0)
    if policy == "skip":
        runs_to_execute = 1 if due_runs == 1 else 0
    elif policy == "coalesce":
        runs_to_execute = 1
    else:
        runs_to_execute = min(due_runs, max_catch_up_runs)

    return IntervalRunDecision(
        policy=policy,
        due_runs=due_runs,
        runs_to_execute=runs_to_execute,
        lateness_seconds=lateness_seconds,
        next_run_in_seconds=0.0,
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
