"""Tests for durable scheduler retry state.

Covers:
- migration 6 creates the retry_state table
- upsert / get / clear DB primitives
- DurableBackoff: initial state, failure persistence, success reset
- DurableBackoff: restart restores persisted state (simulated process restart)
- DurableBackoff: jitter is preserved across persisted state
- DurableBackoff: max_attempts marks terminal and stops persisting further attempts
- DurableBackoff: wait_remaining returns correct remaining time
- DurableBackoff: DB errors are handled gracefully (no crash)
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from talos_agent.db import LocalDB, _MIGRATIONS
from talos_agent.scheduler import DurableBackoff


# ── Helpers ────────────────────────────────────────────────────────────────────

def _fresh_db(tmp_path: Path) -> LocalDB:
    return LocalDB(path=tmp_path / "test.db")


# ── Migration tests ────────────────────────────────────────────────────────────

def test_migration_6_creates_retry_state_table(tmp_path: Path):
    """After a fresh init the retry_state table must exist at schema version 6."""
    db = _fresh_db(tmp_path)

    cursor = db._conn.cursor()
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='retry_state'"
    )
    assert cursor.fetchone() is not None, "retry_state table not created by migration 6"

    # Verify schema version
    cursor.execute("PRAGMA user_version;")
    version = cursor.fetchone()[0]
    latest = _MIGRATIONS[-1][0]
    assert version == latest

    db.close()


def test_migration_6_retry_state_columns(tmp_path: Path):
    """retry_state table must have exactly the expected columns."""
    db = _fresh_db(tmp_path)

    cursor = db._conn.cursor()
    cursor.execute("PRAGMA table_info(retry_state)")
    cols = {row[1] for row in cursor.fetchall()}

    assert cols == {"task_name", "attempt_count", "next_attempt_at", "terminal", "updated_at"}
    db.close()


def test_migration_upgrade_to_6_from_5(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """An existing v5 database should acquire the retry_state table after upgrade."""
    db_file = tmp_path / "v5.db"

    # Seed a minimal v5 database (just the user_version pragma)
    conn = sqlite3.connect(str(db_file))
    conn.execute("PRAGMA user_version = 5;")
    conn.commit()
    conn.close()

    # Only expose migrations 6+ during upgrade so the runner picks up migration 6
    migration_6 = next(m for m in _MIGRATIONS if m[0] == 6)
    monkeypatch.setattr("talos_agent.db._MIGRATIONS", [migration_6])

    db = LocalDB(path=db_file)

    cursor = db._conn.cursor()
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='retry_state'"
    )
    assert cursor.fetchone() is not None

    cursor.execute("PRAGMA user_version;")
    assert cursor.fetchone()[0] == 6

    db.close()


# ── DB primitive tests ─────────────────────────────────────────────────────────

def test_get_retry_state_returns_none_for_unknown_task(tmp_path: Path):
    db = _fresh_db(tmp_path)
    assert db.get_retry_state("no_such_task") is None
    db.close()


def test_upsert_and_get_retry_state_roundtrip(tmp_path: Path):
    db = _fresh_db(tmp_path)
    ts = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    db.upsert_retry_state("polling", attempt_count=3, next_attempt_at=ts, terminal=False)

    state = db.get_retry_state("polling")
    assert state is not None
    assert state["task_name"] == "polling"
    assert state["attempt_count"] == 3
    assert state["next_attempt_at"] == ts
    assert state["terminal"] is False
    db.close()


def test_upsert_overwrites_existing_state(tmp_path: Path):
    db = _fresh_db(tmp_path)
    ts1 = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone.utc)
    ts2 = datetime(2026, 1, 1, 11, 0, 0, tzinfo=timezone.utc)

    db.upsert_retry_state("heartbeat", attempt_count=1, next_attempt_at=ts1)
    db.upsert_retry_state("heartbeat", attempt_count=5, next_attempt_at=ts2, terminal=True)

    state = db.get_retry_state("heartbeat")
    assert state["attempt_count"] == 5
    assert state["next_attempt_at"] == ts2
    assert state["terminal"] is True
    db.close()


def test_clear_retry_state_removes_row(tmp_path: Path):
    db = _fresh_db(tmp_path)
    ts = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    db.upsert_retry_state("activity_flush", attempt_count=2, next_attempt_at=ts)
    assert db.get_retry_state("activity_flush") is not None

    db.clear_retry_state("activity_flush")
    assert db.get_retry_state("activity_flush") is None
    db.close()


def test_clear_retry_state_noop_for_unknown_task(tmp_path: Path):
    """Clearing a non-existent task must not raise."""
    db = _fresh_db(tmp_path)
    db.clear_retry_state("ghost_task")  # should not raise
    db.close()


def test_terminal_flag_stored_as_bool(tmp_path: Path):
    db = _fresh_db(tmp_path)
    ts = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    db.upsert_retry_state("task_a", attempt_count=0, next_attempt_at=ts, terminal=True)
    state = db.get_retry_state("task_a")
    assert state["terminal"] is True

    db.upsert_retry_state("task_b", attempt_count=0, next_attempt_at=ts, terminal=False)
    state = db.get_retry_state("task_b")
    assert state["terminal"] is False
    db.close()


def test_multiple_tasks_are_isolated(tmp_path: Path):
    """Rows for different task names must not interfere with each other."""
    db = _fresh_db(tmp_path)
    ts = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)

    db.upsert_retry_state("task_x", attempt_count=1, next_attempt_at=ts)
    db.upsert_retry_state("task_y", attempt_count=7, next_attempt_at=ts)

    assert db.get_retry_state("task_x")["attempt_count"] == 1
    assert db.get_retry_state("task_y")["attempt_count"] == 7

    db.clear_retry_state("task_x")
    assert db.get_retry_state("task_x") is None
    assert db.get_retry_state("task_y") is not None
    db.close()


# ── DurableBackoff unit tests ──────────────────────────────────────────────────

def test_durable_backoff_initial_state_no_db_row(tmp_path: Path):
    """Fresh DurableBackoff with no persisted row starts at fail_count=0."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff("polling", db=db, base_delay=10.0, jitter=0)

    assert bo.fail_count == 0
    assert not bo.is_terminal
    assert bo.next_delay() == 10.0
    db.close()


def test_durable_backoff_failure_persists_state(tmp_path: Path):
    """After failure(), the DB must reflect the updated attempt count."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff("heartbeat", db=db, base_delay=5.0, initial_backoff=2.0, jitter=0)

    bo.failure()

    state = db.get_retry_state("heartbeat")
    assert state is not None
    assert state["attempt_count"] == 1
    assert state["terminal"] is False
    assert state["next_attempt_at"] > datetime.now(timezone.utc)
    db.close()


def test_durable_backoff_exponential_delays(tmp_path: Path):
    """Delays double with each failure (no jitter)."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "activity_flush", db=db, base_delay=30.0, initial_backoff=2.0,
        max_backoff=300.0, jitter=0,
    )

    bo.failure()
    assert bo.next_delay() == 2.0

    bo.failure()
    assert bo.next_delay() == 4.0

    bo.failure()
    assert bo.next_delay() == 8.0
    db.close()


def test_durable_backoff_max_backoff_cap(tmp_path: Path):
    """Delay must be capped at max_backoff."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "heartbeat", db=db, base_delay=5.0, initial_backoff=2.0,
        max_backoff=10.0, jitter=0,
    )
    for _ in range(10):
        bo.failure()
    assert bo.next_delay() == 10.0
    db.close()


def test_durable_backoff_jitter_preserved(tmp_path: Path):
    """With jitter enabled, delays should vary and stay within ±jitter% of the base."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "polling", db=db, base_delay=10.0, initial_backoff=100.0, jitter=0.2,
    )
    bo.failure()  # fail_count=1 → delay ≈ 100 ±20%

    delays = [bo.next_delay() for _ in range(50)]
    for d in delays:
        assert 80.0 <= d <= 120.0, f"Delay {d} outside jitter range"
    # Should not be identical
    assert len(set(delays)) > 1
    db.close()


def test_durable_backoff_success_clears_db(tmp_path: Path):
    """success() must remove the persisted state row."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff("heartbeat", db=db, base_delay=5.0, jitter=0)

    bo.failure()
    assert db.get_retry_state("heartbeat") is not None

    bo.success()
    assert db.get_retry_state("heartbeat") is None
    assert bo.fail_count == 0
    assert not bo.is_terminal
    db.close()


def test_durable_backoff_success_resets_delay_to_base(tmp_path: Path):
    """After success(), next_delay() must return the base delay."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff("polling", db=db, base_delay=10.0, initial_backoff=2.0, jitter=0)

    bo.failure()
    bo.failure()
    assert bo.next_delay() == 4.0  # exponential

    bo.success()
    assert bo.next_delay() == 10.0  # back to base
    db.close()


# ── Restart / persistence tests ────────────────────────────────────────────────

def test_durable_backoff_restores_fail_count_after_restart(tmp_path: Path):
    """A new DurableBackoff instance reading the same DB restores fail_count."""
    db_path = tmp_path / "restart.db"

    # Simulate pre-restart session
    db1 = LocalDB(path=db_path)
    bo1 = DurableBackoff("polling", db=db1, base_delay=5.0, initial_backoff=2.0, jitter=0)
    bo1.failure()
    bo1.failure()
    bo1.failure()
    assert bo1.fail_count == 3
    db1.close()

    # Simulate process restart
    db2 = LocalDB(path=db_path)
    bo2 = DurableBackoff("polling", db=db2, base_delay=5.0, initial_backoff=2.0, jitter=0)

    assert bo2.fail_count == 3, "fail_count not restored after restart"
    db2.close()


def test_durable_backoff_restores_next_attempt_at_after_restart(tmp_path: Path):
    """A restarted DurableBackoff must restore next_attempt_at from DB."""
    db_path = tmp_path / "restart2.db"

    db1 = LocalDB(path=db_path)
    bo1 = DurableBackoff("heartbeat", db=db1, base_delay=5.0, initial_backoff=60.0, jitter=0)
    bo1.failure()
    expected_next = bo1._next_attempt_at
    db1.close()

    db2 = LocalDB(path=db_path)
    bo2 = DurableBackoff("heartbeat", db=db2, base_delay=5.0, initial_backoff=60.0, jitter=0)

    assert bo2._next_attempt_at is not None
    # Allow 1-second tolerance for microsecond rounding in ISO formatting
    diff = abs((bo2._next_attempt_at - expected_next).total_seconds())
    assert diff < 1.0, f"next_attempt_at diverged by {diff}s after restart"
    db2.close()


def test_durable_backoff_wait_remaining_after_restart(tmp_path: Path):
    """wait_remaining() after restart should reflect remaining backoff time."""
    db_path = tmp_path / "restart3.db"

    db1 = LocalDB(path=db_path)
    # Use a large initial_backoff so the wait window is clearly in the future
    bo1 = DurableBackoff(
        "activity_flush", db=db1, base_delay=5.0, initial_backoff=3600.0,
        max_backoff=7200.0, jitter=0,
    )
    bo1.failure()
    db1.close()

    db2 = LocalDB(path=db_path)
    bo2 = DurableBackoff(
        "activity_flush", db=db2, base_delay=5.0, initial_backoff=3600.0,
        max_backoff=7200.0, jitter=0,
    )
    remaining = bo2.wait_remaining()
    assert remaining > 0, "wait_remaining should be > 0 after restart with future next_attempt_at"
    assert remaining <= 3600.0 + 5, "wait_remaining should not exceed the initial_backoff delay"
    db2.close()


def test_durable_backoff_wait_remaining_zero_when_overdue(tmp_path: Path):
    """wait_remaining() returns 0 when next_attempt_at is in the past."""
    db = _fresh_db(tmp_path)
    # Manually plant a state with next_attempt_at already in the past
    past = datetime.now(timezone.utc) - timedelta(seconds=60)
    db.upsert_retry_state("polling", attempt_count=2, next_attempt_at=past)

    bo = DurableBackoff("polling", db=db, base_delay=5.0, jitter=0)
    assert bo.wait_remaining() == 0.0
    db.close()


def test_durable_backoff_terminal_not_set_on_fresh_start(tmp_path: Path):
    """is_terminal must be False when no persisted row exists."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff("heartbeat", db=db, base_delay=5.0)
    assert not bo.is_terminal
    db.close()


def test_durable_backoff_restores_terminal_flag_after_restart(tmp_path: Path):
    """terminal=True must survive a process restart."""
    db_path = tmp_path / "terminal.db"

    db1 = LocalDB(path=db_path)
    bo1 = DurableBackoff(
        "polling", db=db1, base_delay=5.0, initial_backoff=2.0, jitter=0, max_attempts=2
    )
    bo1.failure()
    bo1.failure()  # hits max_attempts → terminal
    assert bo1.is_terminal
    db1.close()

    db2 = LocalDB(path=db_path)
    bo2 = DurableBackoff(
        "polling", db=db2, base_delay=5.0, initial_backoff=2.0, jitter=0, max_attempts=2
    )
    assert bo2.is_terminal, "terminal flag not restored after restart"
    db2.close()


# ── max_attempts semantics ─────────────────────────────────────────────────────

def test_durable_backoff_max_attempts_marks_terminal(tmp_path: Path):
    """Exceeding max_attempts must flip is_terminal and persist it."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "polling", db=db, base_delay=5.0, initial_backoff=2.0, jitter=0, max_attempts=3
    )

    bo.failure()
    assert not bo.is_terminal
    bo.failure()
    assert not bo.is_terminal
    bo.failure()
    assert bo.is_terminal

    state = db.get_retry_state("polling")
    assert state["terminal"] is True
    db.close()


def test_durable_backoff_zero_max_attempts_never_terminal(tmp_path: Path):
    """max_attempts=0 (unlimited) must never set is_terminal."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "heartbeat", db=db, base_delay=5.0, initial_backoff=2.0, jitter=0, max_attempts=0
    )
    for _ in range(20):
        bo.failure()
    assert not bo.is_terminal
    db.close()


def test_durable_backoff_success_clears_terminal_flag(tmp_path: Path):
    """success() after a terminal state must clear the terminal flag."""
    db = _fresh_db(tmp_path)
    bo = DurableBackoff(
        "polling", db=db, base_delay=5.0, initial_backoff=2.0, jitter=0, max_attempts=1
    )
    bo.failure()
    assert bo.is_terminal

    bo.success()
    assert not bo.is_terminal
    assert bo.fail_count == 0
    assert db.get_retry_state("polling") is None
    db.close()


# ── Robustness / edge-case tests ───────────────────────────────────────────────

def test_durable_backoff_tolerates_db_get_error(tmp_path: Path):
    """DurableBackoff must not raise if get_retry_state throws on construction."""
    bad_db = MagicMock()
    bad_db.get_retry_state = MagicMock(side_effect=RuntimeError("DB locked"))
    bad_db.upsert_retry_state = MagicMock()
    bad_db.clear_retry_state = MagicMock()

    bo = DurableBackoff("polling", db=bad_db, base_delay=5.0, jitter=0)
    assert bo.fail_count == 0  # graceful fallback


def test_durable_backoff_tolerates_db_upsert_error(tmp_path: Path):
    """failure() must not raise even when upsert_retry_state throws."""
    bad_db = MagicMock()
    bad_db.get_retry_state = MagicMock(return_value=None)
    bad_db.upsert_retry_state = MagicMock(side_effect=RuntimeError("DB full"))
    bad_db.clear_retry_state = MagicMock()

    bo = DurableBackoff("polling", db=bad_db, base_delay=5.0, initial_backoff=2.0, jitter=0)
    bo.failure()  # should not raise
    assert bo.fail_count == 1  # in-memory state still updated


def test_durable_backoff_tolerates_db_clear_error(tmp_path: Path):
    """success() must not raise even when clear_retry_state throws."""
    bad_db = MagicMock()
    bad_db.get_retry_state = MagicMock(return_value=None)
    bad_db.upsert_retry_state = MagicMock()
    bad_db.clear_retry_state = MagicMock(side_effect=RuntimeError("I/O error"))

    bo = DurableBackoff("polling", db=bad_db, base_delay=5.0, jitter=0)
    bo.failure()
    bo.success()  # should not raise
    assert bo.fail_count == 0


def test_durable_backoff_independent_tasks_do_not_interfere(tmp_path: Path):
    """Two DurableBackoff instances for different tasks share the DB but are isolated."""
    db = _fresh_db(tmp_path)

    bo_poll = DurableBackoff("polling", db=db, base_delay=5.0, initial_backoff=2.0, jitter=0)
    bo_hb = DurableBackoff("heartbeat", db=db, base_delay=30.0, initial_backoff=4.0, jitter=0)

    bo_poll.failure()
    bo_poll.failure()
    bo_hb.failure()

    assert bo_poll.fail_count == 2
    assert bo_hb.fail_count == 1

    bo_poll.success()
    assert bo_poll.fail_count == 0
    assert bo_hb.fail_count == 1  # heartbeat unaffected

    assert db.get_retry_state("polling") is None
    assert db.get_retry_state("heartbeat") is not None
    db.close()
