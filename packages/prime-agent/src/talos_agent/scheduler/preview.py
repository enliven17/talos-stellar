"""Pure helpers for previewing nominal scheduler executions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from talos_agent.clock import ClockProtocol
from talos_agent.scheduler.intervals import (
    ACTIVITY_FLUSH_INTERVAL_SECONDS,
    LEARNING_CYCLE_INTERVAL_SECONDS,
    LOAN_REPAYMENT_INTERVAL_SECONDS,
    TELEMETRY_INTERVAL_SECONDS,
)

if TYPE_CHECKING:
    from talos_agent.config import Settings


@dataclass(frozen=True)
class SchedulePreviewEntry:
    """One nominal scheduler execution in a preview."""

    task_name: str
    scheduled_at: datetime
    interval_seconds: float


def preview_schedule(
    settings: Settings,
    clock: ClockProtocol,
    *,
    count: int = 20,
) -> list[SchedulePreviewEntry]:
    """Return the next ``count`` nominal task executions from ``clock``.

    This is an estimate based on configured intervals. Persisted retry
    deadlines, retry backoff, task state, and runtime conditions are not read.
    """
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 1000:
        raise ValueError("count must be an integer between 1 and 1000")

    now = clock.now()
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("clock.now() must return a timezone-aware datetime")
    now = now.astimezone(timezone.utc)

    schedules: list[tuple[str, float, float]] = [
        ("activity_flush", ACTIVITY_FLUSH_INTERVAL_SECONDS, 0),
        ("agent_cycle", settings.agent_cycle_interval, 0),
        ("heartbeat", settings.heartbeat_interval, 0),
        ("job_heartbeat", settings.job_heartbeat_interval, 0),
        ("learning_cycle", LEARNING_CYCLE_INTERVAL_SECONDS, LEARNING_CYCLE_INTERVAL_SECONDS),
        ("loan_repayment", LOAN_REPAYMENT_INTERVAL_SECONDS, LOAN_REPAYMENT_INTERVAL_SECONDS),
        ("polling", settings.polling_interval, 0),
        (
            "dividend_distribution",
            settings.dividend_distribution_interval,
            settings.dividend_distribution_interval,
        ),
        ("telemetry_log", TELEMETRY_INTERVAL_SECONDS, TELEMETRY_INTERVAL_SECONDS),
    ]

    if settings.talos_durable_job_effects_enabled:
        schedules.append(
            ("job_effect_dispatch", settings.talos_job_effect_dispatch_interval, 0)
        )
    if settings.telegram_rate_limit_enabled:
        schedules.append(
            ("telegram_queue", settings.telegram_queue_drain_interval_seconds, 0)
        )

    executions: list[SchedulePreviewEntry] = []
    for task_name, interval_seconds, first_delay_seconds in schedules:
        try:
            interval = timedelta(seconds=interval_seconds)
            first_run = now + timedelta(seconds=first_delay_seconds)
        except (OverflowError, TypeError, ValueError):
            raise ValueError(f"{task_name} interval is invalid") from None
        if interval <= timedelta(0):
            raise ValueError(f"{task_name} interval must be greater than 0")
        for occurrence in range(count):
            try:
                scheduled_at = first_run + interval * occurrence
            except OverflowError:
                raise ValueError(f"{task_name} schedule exceeds datetime bounds") from None
            executions.append(
                SchedulePreviewEntry(
                    task_name=task_name,
                    scheduled_at=scheduled_at,
                    interval_seconds=interval_seconds,
                )
            )

    executions.sort(key=lambda entry: (entry.scheduled_at, entry.task_name))
    return executions[:count]
