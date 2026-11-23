"""Tests for adapter-specific operator pause and in-flight outcome reporting.

Coverage
--------
AdapterPauseController:
  pause / resume / is_paused / state / all_states
  record_in_flight / resolve_in_flight / uncertain_sends
  in_flight_report (PauseReport)
  unrelated adapters unaffected
  boundary: resolve unknown send_id returns None
  boundary: double-pause is a no-op
  InFlightRecord.to_dict includes resolved_at only when resolved
  PauseReport.to_dict structure

AdapterRegistry (pause integration):
  pause / resume / is_paused delegate correctly
  pause_report returns correct PauseReport
  unregistered channel defaults to running
"""

from __future__ import annotations

import datetime
from unittest.mock import MagicMock

import pytest

from talos_agent.adapters.diagnostics import (
    AdapterPauseController,
    InFlightRecord,
    PauseReport,
    PauseState,
)
from talos_agent.adapters.registry import AdapterRegistry


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _adapter(name: str) -> MagicMock:
    a = MagicMock()
    a.channel_name = name
    caps = MagicMock()
    caps.__dict__ = {"char_limit": 280, "supports_media": False}
    a.get_capabilities.return_value = caps
    return a


# ─── AdapterPauseController — pause / resume ──────────────────────────────────


class TestPauseResume:
    def test_default_state_is_running(self):
        ctrl = AdapterPauseController()
        assert ctrl.is_paused("discord") is False
        assert ctrl.state("discord") == PauseState.RUNNING

    def test_pause_sets_paused(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        assert ctrl.is_paused("discord") is True
        assert ctrl.state("discord") == PauseState.PAUSED

    def test_resume_clears_pause(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        ctrl.resume("discord")
        assert ctrl.is_paused("discord") is False
        assert ctrl.state("discord") == PauseState.RUNNING

    def test_double_pause_is_noop(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        ctrl.pause("discord")
        assert ctrl.state("discord") == PauseState.PAUSED

    def test_case_insensitive(self):
        ctrl = AdapterPauseController()
        ctrl.pause("Discord")
        assert ctrl.is_paused("DISCORD") is True
        assert ctrl.is_paused("discord") is True

    def test_unrelated_adapter_unaffected(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        # Telegram was never touched — must remain running
        assert ctrl.is_paused("telegram") is False
        assert ctrl.state("telegram") == PauseState.RUNNING

    def test_all_states_returns_only_touched(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        ctrl.resume("telegram")
        states = ctrl.all_states()
        assert states["discord"] == "paused"
        assert states["telegram"] == "running"


# ─── In-flight recording ──────────────────────────────────────────────────────


class TestInFlight:
    def test_record_creates_record(self):
        ctrl = AdapterPauseController()
        rec = ctrl.record_in_flight("discord", "send-001")
        assert isinstance(rec, InFlightRecord)
        assert rec.send_id == "send-001"
        assert rec.outcome is None
        assert rec.resolved_at is None

    def test_started_at_is_utc(self):
        ctrl = AdapterPauseController()
        rec = ctrl.record_in_flight("discord", "send-001")
        assert rec.started_at.tzinfo is not None

    def test_resolve_sets_outcome_and_resolved_at(self):
        ctrl = AdapterPauseController()
        ctrl.record_in_flight("discord", "send-001")
        rec = ctrl.resolve_in_flight("discord", "send-001", outcome="posted")
        assert rec is not None
        assert rec.outcome == "posted"
        assert rec.resolved_at is not None
        assert rec.resolved_at.tzinfo is not None

    def test_resolve_unknown_send_id_returns_none(self):
        ctrl = AdapterPauseController()
        result = ctrl.resolve_in_flight("discord", "nonexistent", outcome="failed")
        assert result is None

    def test_resolve_unknown_adapter_returns_none(self):
        ctrl = AdapterPauseController()
        result = ctrl.resolve_in_flight("telegram", "send-001", outcome="posted")
        assert result is None

    def test_uncertain_sends_excludes_resolved(self):
        ctrl = AdapterPauseController()
        ctrl.record_in_flight("discord", "s1")
        ctrl.record_in_flight("discord", "s2")
        ctrl.resolve_in_flight("discord", "s1", outcome="posted")
        uncertain = ctrl.uncertain_sends("discord")
        assert len(uncertain) == 1
        assert uncertain[0].send_id == "s2"

    def test_uncertain_sends_empty_when_all_resolved(self):
        ctrl = AdapterPauseController()
        ctrl.record_in_flight("discord", "s1")
        ctrl.resolve_in_flight("discord", "s1", outcome="failed")
        assert ctrl.uncertain_sends("discord") == []

    def test_uncertain_sends_unrelated_adapter_unaffected(self):
        ctrl = AdapterPauseController()
        ctrl.record_in_flight("discord", "s1")
        # Telegram has no in-flight records; uncertain_sends must not raise
        assert ctrl.uncertain_sends("telegram") == []

    def test_multiple_sends_tracked_independently(self):
        ctrl = AdapterPauseController()
        ctrl.record_in_flight("discord", "s1")
        ctrl.record_in_flight("discord", "s2")
        ctrl.record_in_flight("telegram", "t1")
        ctrl.resolve_in_flight("discord", "s1", outcome="posted")
        ctrl.resolve_in_flight("telegram", "t1", outcome="failed")

        discord_uncertain = ctrl.uncertain_sends("discord")
        telegram_uncertain = ctrl.uncertain_sends("telegram")

        assert len(discord_uncertain) == 1
        assert discord_uncertain[0].send_id == "s2"
        assert telegram_uncertain == []


# ─── PauseReport via in_flight_report ─────────────────────────────────────────


class TestInFlightReport:
    def test_report_paused_flag(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        report = ctrl.in_flight_report("discord")
        assert isinstance(report, PauseReport)
        assert report.paused is True

    def test_report_running_flag(self):
        ctrl = AdapterPauseController()
        report = ctrl.in_flight_report("discord")
        assert report.paused is False

    def test_report_contains_in_flight_records(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        ctrl.record_in_flight("discord", "s1")
        ctrl.record_in_flight("discord", "s2")
        report = ctrl.in_flight_report("discord")
        assert len(report.in_flight) == 2

    def test_report_empty_when_no_records(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        report = ctrl.in_flight_report("discord")
        assert report.in_flight == []

    def test_report_to_dict_structure(self):
        ctrl = AdapterPauseController()
        ctrl.pause("discord")
        ctrl.record_in_flight("discord", "s1")
        ctrl.resolve_in_flight("discord", "s1", outcome="posted")
        d = ctrl.in_flight_report("discord").to_dict()
        assert d["paused"] is True
        assert d["adapter"] == "discord"
        assert len(d["in_flight"]) == 1
        assert d["in_flight"][0]["outcome"] == "posted"
        assert "generated_at" in d

    def test_report_has_generated_at_utc(self):
        ctrl = AdapterPauseController()
        report = ctrl.in_flight_report("discord")
        assert report.generated_at.tzinfo is not None


# ─── InFlightRecord.to_dict ───────────────────────────────────────────────────


class TestInFlightRecordToDict:
    def test_unresolved_no_resolved_at_key(self):
        rec = InFlightRecord(send_id="x")
        d = rec.to_dict()
        assert "resolved_at" not in d
        assert d["outcome"] is None

    def test_resolved_includes_resolved_at(self):
        rec = InFlightRecord(send_id="x")
        rec.outcome = "posted"
        rec.resolved_at = datetime.datetime.now(datetime.timezone.utc)
        d = rec.to_dict()
        assert "resolved_at" in d
        assert d["outcome"] == "posted"


# ─── AdapterRegistry integration ────────────────────────────────────────────


class TestRegistryPauseIntegration:
    def test_pause_and_is_paused(self):
        registry = AdapterRegistry()
        registry.register(_adapter("Discord"))
        registry.pause("Discord")
        assert registry.is_paused("discord") is True

    def test_resume_clears_pause(self):
        registry = AdapterRegistry()
        registry.register(_adapter("Discord"))
        registry.pause("Discord")
        registry.resume("Discord")
        assert registry.is_paused("discord") is False

    def test_unregistered_channel_not_paused_by_default(self):
        registry = AdapterRegistry()
        assert registry.is_paused("telegram") is False

    def test_pause_one_does_not_affect_other(self):
        registry = AdapterRegistry()
        registry.register(_adapter("Discord"))
        registry.register(_adapter("Telegram"))
        registry.pause("Discord")
        assert registry.is_paused("discord") is True
        assert registry.is_paused("telegram") is False

    def test_pause_report_returned(self):
        registry = AdapterRegistry()
        registry.register(_adapter("Discord"))
        registry.pause("discord")
        registry.pause_controller.record_in_flight("discord", "job-1")
        registry.pause_controller.resolve_in_flight("discord", "job-1", outcome="failed")
        report = registry.pause_report("discord")
        assert isinstance(report, PauseReport)
        assert report.paused is True
        assert len(report.in_flight) == 1
        assert report.in_flight[0].outcome == "failed"

    def test_pause_report_unpaused_adapter(self):
        registry = AdapterRegistry()
        registry.register(_adapter("Telegram"))
        report = registry.pause_report("telegram")
        assert report.paused is False
        assert report.in_flight == []
