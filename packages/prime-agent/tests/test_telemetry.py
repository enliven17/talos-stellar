"""Tests for telemetry collector — privacy, accuracy, redaction."""

from __future__ import annotations

from unittest.mock import MagicMock, PropertyMock

import pytest

from talos_agent.telemetry import (
    TelemetryCollector,
    TelemetryReport,
    _is_sensitive_key,
    _redact_if_sensitive,
)


class TestSensitiveKeyDetection:
    """Unit tests for the privacy guard functions."""

    @pytest.mark.parametrize(
        "key, expected",
        [
            ("api_key", True),
            ("API_KEY", True),
            ("signature", True),
            ("wallet_secret", True),
            ("prompt", True),
            ("provider", False),  # allowed
            ("state", False),  # allowed
            ("total_successes", False),  # allowed
            ("pending_count", False),  # allowed
        ],
    )
    def test_sensitive_key_detection(self, key: str, expected: bool) -> None:
        assert _is_sensitive_key(key) == expected

    def test_redact_if_sensitive_redacts_matching_keys(self) -> None:
        assert _redact_if_sensitive("api_key", "sk-1234") == "[REDACTED]"

    def test_redact_if_sensitive_passes_safe_keys(self) -> None:
        assert _redact_if_sensitive("total_successes", 42) == 42


class TestTelemetryCollector:
    """Integration-style tests for the collector."""

    @pytest.fixture
    def mock_db(self):
        """Create a LocalDB-alike with minimal stubs."""
        db = MagicMock()

        # get_last_run
        db.get_last_run.return_value = None

        # get_retry_state
        db.get_retry_state.return_value = None

        # get_performance_summary
        db.get_performance_summary.return_value = {
            "total_posts": 5,
            "total_impressions": 1200,
            "avg_engagement": 3.2,
        }

        # SQL queries for queue depth
        def fake_execute(sql: str):
            result = MagicMock()
            if "WHERE status = 'pending'" in sql:
                result.fetchone.return_value = {"cnt": 3}
            elif "COUNT" in sql:
                result.fetchone.return_value = {"cnt": 15}
            else:
                result.fetchone.return_value = None
            return result

        db._conn = MagicMock()
        db._conn.execute = fake_execute

        return db

    @pytest.fixture
    def collector(self, mock_db):
        return TelemetryCollector(db=mock_db, agent_name="test-agent")

    def test_collect_returns_report_with_metadata(self, collector):
        report = collector.collect()
        assert isinstance(report, TelemetryReport)
        assert report.agent_name == "test-agent"
        assert report.collected_at != ""

    def test_collect_includes_all_scheduler_tasks(self, collector):
        report = collector.collect()
        task_names = {t.name for t in report.tasks}
        expected = {
            "agent_cycle",
            "polling",
            "heartbeat",
            "job_heartbeat",
            "activity_flush",
            "learning_cycle",
            "dividend_distribution",
            "loan_repayment",
        }
        assert task_names == expected

    def test_collect_includes_queue_depth(self, collector):
        report = collector.collect()
        queue_names = {q.name for q in report.queues}
        assert "commerce_queue" in queue_names
        assert "activity_log" in queue_names
        assert "approval_cache" in queue_names

        for q in report.queues:
            if q.name == "commerce_queue":
                assert q.pending_count == 3
                assert q.total_count == 15

    def test_collect_includes_content_performance(self, collector):
        report = collector.collect()
        assert report.total_posts_7d == 5
        assert report.total_impressions_7d == 1200
        assert report.avg_engagement_7d == 3.2

    def test_collect_circuit_breakers(self, collector):
        """Circuit breaker metrics are included and privacy-safe."""
        mock_registry = MagicMock()
        mock_registry.all_metrics.return_value = {
            "groq": {
                "provider": "groq",
                "state": "closed",
                "failures_in_window": 0,
                "total_successes": 100,
                "total_failures": 2,
                "total_rejected": 0,
                "total_probes": 0,
                "remaining_cooldown_s": None,
            }
        }

        report = collector.collect(cb_registry=mock_registry)
        assert len(report.circuit_breakers) == 1
        assert report.circuit_breakers[0]["provider"] == "groq"
        assert report.circuit_breakers[0]["state"] == "closed"

    def test_circuit_breaker_sensitive_provider_is_skipped(self, collector):
        """A provider whose name matches a sensitive token is excluded."""
        mock_registry = MagicMock()
        mock_registry.all_metrics.return_value = {
            "api_key_manager": {
                "provider": "api_key_manager",
                "state": "closed",
            }
        }

        report = collector.collect(cb_registry=mock_registry)
        assert len(report.circuit_breakers) == 0

    def test_collect_policy_metrics(self, collector):
        """Policy engine counters are included."""
        mock_engine = MagicMock()
        type(mock_engine).metrics = PropertyMock(
            return_value={
                "evaluation_count": 42,
                "deny_count": 3,
                "escalate_count": 7,
            }
        )

        report = collector.collect(policy_engine=mock_engine)
        assert report.policy_evaluation_count == 42
        assert report.policy_deny_count == 3
        assert report.policy_escalate_count == 7

    def test_retry_state_is_collected(self, collector, mock_db):
        """When retry_state exists it populates the task metrics."""
        from datetime import datetime, timedelta, timezone

        mock_db.get_retry_state.return_value = {
            "attempt_count": 3,
            "terminal": False,
            "next_attempt_at": datetime.now(timezone.utc) + timedelta(seconds=30),
        }

        report = collector.collect()
        polling = next(t for t in report.tasks if t.name == "polling")
        assert polling.retry_attempts == 3
        assert polling.is_terminal is False
        assert polling.retry_remaining_seconds > 0

    def test_schedule_run_is_collected(self, collector, mock_db):
        """When a schedule entry exists it is reflected in the report."""
        from datetime import datetime, timezone

        mock_db.get_last_run.side_effect = lambda name: (
            datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc)
            if name == "agent_cycle"
            else None
        )

        report = collector.collect()
        agent_cycle = next(t for t in report.tasks if t.name == "agent_cycle")
        assert agent_cycle.last_run_at is not None
        assert "2026-07-27" in agent_cycle.last_run_at

    def test_to_json_is_serializable(self, collector):
        """JSON output is valid and contains no sensitive keywords."""
        report = collector.collect()
        json_str = report.to_json()
        import json

        parsed = json.loads(json_str)
        assert isinstance(parsed, dict)
        assert "tasks" in parsed
        assert "queues" in parsed

        # Confirm no sensitive strings leaked into the output
        json_lower = json_str.lower()
        assert "api_key" not in json_lower
        assert "signature" not in json_lower
        assert "wallet_secret" not in json_lower

    def test_to_dict_strips_empty_containers(self, collector):
        """Empty lists and None values are omitted for clean output."""
        report = collector.collect()
        d = report.to_dict()
        # uptime_hours is 0 — not omitted because 0 != None and 0 != []
        # But if it were None, it would be stripped
        assert "adapters" not in d  # empty list

    def test_add_adapter_health(self, collector):
        """Adapter health probe results can be attached externally."""
        from types import SimpleNamespace

        results = [
            SimpleNamespace(
                to_dict=lambda: {
                    "adapter": "Discord",
                    "state": "healthy",
                    "detail": "webhook configured",
                }
            ),
            SimpleNamespace(
                to_dict=lambda: {
                    "adapter": "X",
                    "state": "degraded",
                    "detail": "browser not initialised",
                }
            ),
        ]

        report = collector.collect()
        collector.add_adapter_health(report, results)

        assert len(report.adapters) == 2
        assert report.adapters[0].name == "Discord"
        assert report.adapters[1].state == "degraded"

    def test_adapter_health_redacts_sensitive_names(self, collector):
        """Adapter names that look sensitive are redacted in telemetry."""
        from types import SimpleNamespace

        results = [
            SimpleNamespace(
                to_dict=lambda: {
                    "adapter": "api_key_provider",
                    "state": "healthy",
                    "detail": "API key configured",
                }
            ),
        ]

        report = collector.collect()
        collector.add_adapter_health(report, results)
        assert report.adapters[0].name == "[REDACTED]"
