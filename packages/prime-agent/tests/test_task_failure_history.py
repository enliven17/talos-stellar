"""Tests for bounded task failure history persistence (Issue #1435)."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

from talos_agent.db import LocalDB
from talos_agent.db.repos.retry import normalize_error_code
from talos_agent.scheduler.backoff import DurableBackoff
from talos_agent.scheduler.policy import check_task_eligibility


class FakeClock:
    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    def now(self) -> datetime:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += timedelta(seconds=seconds)


class FakeCustomError(Exception):
    code = "custom_auth_failure"


class AnotherError(Exception):
    pass


def test_normalize_error_code():
    assert normalize_error_code("rate_limit_exceeded") == "rate_limit_exceeded"
    assert normalize_error_code("RateLimitExceeded") == "rate_limit_exceeded"
    assert normalize_error_code("connection-timeout") == "connection_timeout"
    assert normalize_error_code("500_server_error") == "err_500_server_error"
    assert normalize_error_code(FakeCustomError("Invalid token")) == "custom_auth_failure"
    assert normalize_error_code(AnotherError("oops")) == "another_error"
    assert normalize_error_code(TimeoutError("socket timed out")) == "timeout_error"
    assert normalize_error_code(None) == "unknown_error"

    # Must never leak sensitive prompt or credentials
    sensitive = "SECRET_API_KEY_xyz123 with prompt: Ignore previous instructions"
    normalized = normalize_error_code(sensitive)
    assert "xyz123" not in normalized
    assert "ignore" not in normalized
    assert len(normalized) <= 64


def test_record_task_failure_schema_and_retention(tmp_path: Path):
    db_path = tmp_path / "test.db"
    db = LocalDB(path=db_path)

    now = datetime.now(timezone.utc)
    next_elig = now + timedelta(seconds=30)

    # Record failure
    rec_id = db.record_task_failure(
        talos_id="agent-007",
        task_name="polling",
        attempt_number=1,
        error_code="http_502_bad_gateway",
        next_eligible_at=next_elig,
        max_history=5,
    )
    assert rec_id > 0

    history = db.get_task_failure_history(talos_id="agent-007", task_name="polling")
    assert len(history) == 1
    entry = history[0]
    assert entry["id"] == rec_id
    assert entry["talos_id"] == "agent-007"
    assert entry["task_name"] == "polling"
    assert entry["attempt_number"] == 1
    assert entry["error_code"] == "http_502_bad_gateway"
    assert entry["next_eligible_at"] == next_elig
    assert "recorded_at" in entry

    # Verify no private/prompt/result columns exist in task_failure_history
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    columns = [col[1] for col in cursor.execute("PRAGMA table_info(task_failure_history)").fetchall()]
    conn.close()
    assert set(columns) == {"id", "talos_id", "task_name", "attempt_number", "error_code", "next_eligible_at", "recorded_at"}

    db.close()


def test_failure_history_bounding_and_pruning(tmp_path: Path):
    db_path = tmp_path / "test.db"
    db = LocalDB(path=db_path)

    now = datetime.now(timezone.utc)

    # Insert 10 records with max_history=3
    for i in range(1, 11):
        db.record_task_failure(
            talos_id="agent-1",
            task_name="heartbeat",
            attempt_number=i,
            error_code=f"attempt_err_{i}",
            next_eligible_at=now + timedelta(seconds=i * 10),
            max_history=3,
        )

    history = db.get_task_failure_history(talos_id="agent-1", task_name="heartbeat", limit=10)
    assert len(history) == 3
    # Check that only the most recent attempts (10, 9, 8) remain
    attempt_numbers = [h["attempt_number"] for h in history]
    assert attempt_numbers == [10, 9, 8]

    db.close()


def test_agent_isolation_in_failure_history(tmp_path: Path):
    db_path = tmp_path / "test.db"
    db = LocalDB(path=db_path)

    now = datetime.now(timezone.utc)

    db.record_task_failure(
        talos_id="agent-A",
        task_name="polling",
        attempt_number=1,
        error_code="conn_err",
        next_eligible_at=now,
    )
    db.record_task_failure(
        talos_id="agent-B",
        task_name="polling",
        attempt_number=1,
        error_code="auth_err",
        next_eligible_at=now,
    )

    history_a = db.get_task_failure_history(talos_id="agent-A")
    assert len(history_a) == 1
    assert history_a[0]["talos_id"] == "agent-A"
    assert history_a[0]["error_code"] == "conn_err"

    history_b = db.get_task_failure_history(talos_id="agent-B")
    assert len(history_b) == 1
    assert history_b[0]["talos_id"] == "agent-B"
    assert history_b[0]["error_code"] == "auth_err"

    db.close()


def test_durable_backoff_integration_with_failure_history(tmp_path: Path):
    db_path = tmp_path / "test.db"
    db = LocalDB(path=db_path)
    clock = FakeClock()

    backoff = DurableBackoff(
        task_name="polling",
        db=db,
        base_delay=10.0,
        initial_backoff=5.0,
        jitter=0,
        clock=clock,
        talos_id="agent-xyz",
        max_failure_history=2,
    )

    # First failure
    backoff.failure(ConnectionResetError("Connection lost"))
    history = db.get_task_failure_history(talos_id="agent-xyz", task_name="polling")
    assert len(history) == 1
    assert history[0]["attempt_number"] == 1
    assert history[0]["error_code"] == "connection_reset_error"
    assert history[0]["next_eligible_at"] == clock.now() + timedelta(seconds=5.0)

    # Second failure with explicit error_code
    backoff.failure(error_code="rate_limit_exceeded")
    history = db.get_task_failure_history(talos_id="agent-xyz", task_name="polling")
    assert len(history) == 2
    assert history[0]["attempt_number"] == 2
    assert history[0]["error_code"] == "rate_limit_exceeded"

    # Third failure exceeds max_failure_history=2 -> oldest entry pruned
    backoff.failure(Exception("Generic failure"))
    history = db.get_task_failure_history(talos_id="agent-xyz", task_name="polling")
    assert len(history) == 2
    assert [h["attempt_number"] for h in history] == [3, 2]

    # Verify policy check_task_eligibility
    # At current clock time, task is backed off
    eligible, next_at = check_task_eligibility(clock.now(), "polling", db, talos_id="agent-xyz")
    assert not eligible
    assert next_at is not None

    # Advance clock past next_at
    clock.advance(100.0)
    eligible, next_at = check_task_eligibility(clock.now(), "polling", db, talos_id="agent-xyz")
    assert eligible

    # Success resets backoff state in retry_state table
    backoff.success()
    assert backoff.fail_count == 0
    assert db.get_retry_state("polling") is None

    # But historical log remains bounded for analysis
    history_after_success = db.get_task_failure_history(talos_id="agent-xyz", task_name="polling")
    assert len(history_after_success) == 2

    db.close()


def test_durable_backoff_backward_compatibility_with_plain_mock_db():
    """Verify that if DB doesn't have record_task_failure, backoff.failure still works."""
    mock_db = MagicMock()
    mock_db.get_retry_state.return_value = None
    del mock_db.record_task_failure  # ensure attribute is absent

    backoff = DurableBackoff(
        task_name="test_task",
        db=mock_db,
        base_delay=5.0,
        jitter=0,
    )
    # Calling failure with and without args should not raise
    backoff.failure()
    assert backoff.fail_count == 1
    mock_db.upsert_retry_state.assert_called_once()

    backoff.failure(ValueError("Bad value"))
    assert backoff.fail_count == 2
