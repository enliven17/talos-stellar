"""Tests for the deterministic, side-effect-free scheduler preview."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from click.testing import CliRunner

from talos_agent.clock import FakeClock
from talos_agent.config import Settings
from talos_agent.scheduler.preview import preview_schedule


def test_preview_schedule_uses_injected_clock_and_sorts_executions():
    now = datetime(2026, 11, 21, 17, 0, tzinfo=timezone.utc)
    settings = Settings(
        _env_file=None,
        agent_cycle_interval=60,
        polling_interval=120,
        heartbeat_interval=30,
        job_heartbeat_interval=90,
        dividend_distribution_interval=300,
    )

    entries = preview_schedule(settings, FakeClock(now), count=8)

    assert [(entry.task_name, entry.scheduled_at) for entry in entries[:5]] == [
        ("activity_flush", now),
        ("agent_cycle", now),
        ("heartbeat", now),
        ("job_heartbeat", now),
        ("polling", now),
    ]
    assert entries[5].task_name == "activity_flush"
    assert entries[5].scheduled_at == datetime(2026, 11, 21, 17, 0, 30, tzinfo=timezone.utc)
    assert all(entry.scheduled_at.tzinfo == timezone.utc for entry in entries)


def test_preview_schedule_includes_only_enabled_optional_tasks():
    now = datetime(2026, 11, 21, 17, 0, tzinfo=timezone.utc)
    settings = Settings(
        _env_file=None,
        talos_durable_job_effects_enabled=True,
        talos_job_effect_dispatch_interval=5,
        telegram_rate_limit_enabled=True,
        telegram_queue_drain_interval_seconds=2,
    )

    entries = preview_schedule(settings, FakeClock(now), count=2)

    assert [(entry.task_name, entry.scheduled_at) for entry in entries] == [
        ("activity_flush", now),
        ("agent_cycle", now),
    ]
    assert "job_effect_dispatch" in {
        entry.task_name
        for entry in preview_schedule(settings, FakeClock(now), count=20)
    }
    assert "telegram_queue" in {
        entry.task_name
        for entry in preview_schedule(settings, FakeClock(now), count=20)
    }


@pytest.mark.parametrize("count", [0, -1, 1001, True, 1.5])
def test_preview_schedule_rejects_invalid_count(count):
    settings = Settings(_env_file=None)
    clock = FakeClock(datetime(2026, 11, 21, tzinfo=timezone.utc))

    with pytest.raises(ValueError, match="count must be"):
        preview_schedule(settings, clock, count=count)


def test_preview_schedule_rejects_naive_clock():
    class NaiveClock:
        def now(self) -> datetime:
            return datetime(2026, 11, 21)

    with pytest.raises(ValueError, match="timezone-aware"):
        preview_schedule(Settings(_env_file=None), NaiveClock())


def test_preview_schedule_rejects_non_positive_configured_intervals():
    settings = Settings(_env_file=None, agent_cycle_interval=0)
    clock = FakeClock(datetime(2026, 11, 21, tzinfo=timezone.utc))

    with pytest.raises(ValueError, match="interval must be greater than 0"):
        preview_schedule(settings, clock)


def test_cli_prints_preview_without_starting_agent(monkeypatch):
    from talos_agent import cli

    fixed_now = datetime(2026, 11, 21, 17, 0, tzinfo=timezone.utc)
    settings = Settings(_env_file=None)
    monkeypatch.setattr(cli, "Settings", lambda: settings)
    monkeypatch.setattr(cli, "SystemClock", lambda: FakeClock(fixed_now), raising=False)

    result = CliRunner().invoke(cli.main, ["scheduler-preview", "--count", "2", "--json"])

    assert result.exit_code == 0, result.output
    entries = json.loads(result.output)
    assert len(entries) == 2
    assert entries[0]["scheduled_at"] == "2026-11-21T17:00:00Z"
    assert entries[0]["task"] == "activity_flush"
