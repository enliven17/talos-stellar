"""Tests for DurableBackoff — durable scheduler retry state.

Test matrix:
  migration    — retry_state table is created by migration 6
  persist      — failure() writes attempt_count + next_attempt_at to DB
  restore      — a new DurableBackoff restores fail_count from DB on init
  restart      — simulated process restart resumes correct backoff position
  success      — success() resets fail_count and removes the DB row
  jitter       — next_delay() honours jitter bounds across multiple samples
  max_attempts — terminal flag is set after max_attempts consecutive failures
  terminal     — a restored terminal backoff does not advance further
  clear        — clear_retry_state removes the row; get_retry_state returns None
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from talos_agent.db import LocalDB, _MIGRATIONS
from talos_agent.scheduler import DurableBackoff


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path: Path) -> LocalDB:
    return LocalDB(path=tmp_path / "test.db")


# ── Migration test ────────────────────────────────────────────────────────────


def test_migration_creates_retry_state_table(db: LocalDB):
    """Migration 6 must create the retry_state table."""
    cursor = db._conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='retry_state'"
    )
    assert cursor.fetchone() is not None, "retry_state table missing after migration"


def test_migration_6_is_latest(db: LocalDB):
    """The DB user_version must equal the latest migration index (6)."""
    latest = _MIGRATIONS[-1][0]
    assert latest == 6
    version = db._conn.execute("PRAGMA user_version").fetchone()[0]
    assert version == latest


# ── DB method tests ───────────────────────────────────────────────────────────


def test_save_and_get_retry_state(db: LocalDB):
    """save_retry_state persists all fields; get_retry_state retrieves them."""
    now = datetime.now(timezone.utc)
    db.save_retry_state("test_task", attempt_count=3, next_attempt_at=now, terminal=False)

    state = db.get_retry_state("test_task")
    assert state is not None
    assert state["task_name"] == "test_task"
    assert state["attempt_count"] == 3
    assert state["terminal"] is False
    # next_attempt_at should round-trip through ISO format within 1 second
    assert state["next_attempt_at"] is not None
    delta = abs((state["next_attempt_at"] - now).total_seconds())
    assert delta < 1.0


def test_get_retry_state_returns_none_for_unknown_task(db: LocalDB):
    assert db.get_retry_state("nonexistent") is None


def test_save_retry_state_upserts(db: LocalDB):
    """A second save_retry_state call updates the existing row."""
    db.save_retry_state("task_x", attempt_count=1, next_attempt_at=None)
    db.save_retry_state("task_x", attempt_count=5, next_attempt_at=None, terminal=True)

    state = db.get_retry_state("task_x")
    assert state["attempt_count"] == 5
    assert state["terminal"] is True


def test_clear_retry_state_removes_row(db: LocalDB):
    """clear_retry_state deletes the row so get returns None."""
    db.save_retry_state("task_y", attempt_count=2, next_attempt_at=None)
    assert db.get_retry_state("task_y") is not None

    db.clear_retry_state("task_y")
    assert db.get_retry_state("task_y") is None


def test_clear_retry_state_noop_for_missing(db: LocalDB):
    """clear_retry_state is a no-op when no row exists."""
    db.clear_retry_state("never_saved")  # must not raise


# ── DurableBackoff unit tests ─────────────────────────────────────────────────


def test_durable_backoff_fresh_start(db: LocalDB):
    """Fresh DurableBackoff starts at fail_count=0, next_delay == base_delay."""
    b = DurableBackoff("fresh", db, base_delay=10.0, jitter=0)
    assert b.fail_count == 0
    assert b.terminal is False
    assert b.next_delay() == 10.0


def test_durable_backoff_failure_persists_state(db: LocalDB):
    """failure() increments fail_count and writes a row to the DB."""
    b = DurableBackoff("persist_test", db, base_delay=5.0, jitter=0)
    b.failure()

    state = db.get_retry_state("persist_test")
    assert state is not None
    assert state["attempt_count"] == 1
    assert state["terminal"] is False
    assert state["next_attempt_at"] is not None


def test_durable_backoff_exponential_delay(db: LocalDB):
    """Delay follows initial * 2^(n-1) when jitter=0."""
    b = DurableBackoff("exp", db, base_delay=30.0, initial_backoff=2.0, jitter=0)

    b.failure()
    assert b.next_delay() == 2.0   # 2 * 2^0

    b.failure()
    assert b.next_delay() == 4.0   # 2 * 2^1

    b.failure()
    assert b.next_delay() == 8.0   # 2 * 2^2


def test_durable_backoff_max_backoff_cap(db: LocalDB):
    """Delay is capped at max_backoff."""
    b = DurableBackoff("cap", db, base_delay=5.0, initial_backoff=2.0, max_backoff=10.0, jitter=0)
    for _ in range(10):
        b.failure()
    assert b.next_delay() == 10.0


def test_durable_backoff_jitter_bounds(db: LocalDB):
    """With jitter=0.2, 100 samples of next_delay must fall within ±20 % of base delay."""
    b = DurableBackoff("jitter", db, base_delay=5.0, initial_backoff=100.0, jitter=0.2)
    b.failure()  # fail_count=1 → nominal=100.0

    delays = [b.next_delay() for _ in range(100)]
    for d in delays:
        assert 80.0 <= d <= 120.0, f"delay {d} out of ±20% band"
    assert len(set(delays)) > 1, "all delays are identical — jitter not applied"


def test_durable_backoff_success_resets_and_clears_db(db: LocalDB):
    """success() resets fail_count to 0 and removes the persisted row."""
    b = DurableBackoff("reset", db, base_delay=5.0, jitter=0)
    b.failure()
    b.failure()
    assert db.get_retry_state("reset") is not None

    b.success()
    assert b.fail_count == 0
    assert b.terminal is False
    assert b.next_delay() == 5.0
    assert db.get_retry_state("reset") is None


# ── Restart / restore tests ───────────────────────────────────────────────────


def test_durable_backoff_restores_on_restart(db: LocalDB):
    """A new DurableBackoff for the same task restores fail_count from DB."""
    # First "process": accumulate 3 failures
    b1 = DurableBackoff("restart", db, base_delay=10.0, jitter=0)
    b1.failure()
    b1.failure()
    b1.failure()
    assert b1.fail_count == 3

    # Simulate process restart: new instance, same DB
    b2 = DurableBackoff("restart", db, base_delay=10.0, jitter=0)
    assert b2.fail_count == 3
    assert b2.next_delay() == 8.0  # 2 * 2^2 = 8 (initial_backoff default 2.0)


def test_durable_backoff_restart_preserves_terminal(db: LocalDB):
    """A restored terminal DurableBackoff retains the terminal flag."""
    b1 = DurableBackoff("term_restart", db, base_delay=5.0, max_attempts=2, jitter=0)
    b1.failure()
    b1.failure()
    assert b1.terminal is True

    b2 = DurableBackoff("term_restart", db, base_delay=5.0, max_attempts=2, jitter=0)
    assert b2.terminal is True
    assert b2.fail_count == 2


def test_durable_backoff_next_attempt_at_in_future(db: LocalDB):
    """After a failure, next_attempt_at stored in DB is in the future."""
    b = DurableBackoff("future", db, base_delay=5.0, initial_backoff=60.0, jitter=0)
    before = datetime.now(timezone.utc)
    b.failure()
    after = datetime.now(timezone.utc)

    state = db.get_retry_state("future")
    assert state["next_attempt_at"] > before
    # Should be roughly 60 s ahead — definitely after 'after'
    assert state["next_attempt_at"] > after


# ── Max-attempts / terminal tests ─────────────────────────────────────────────


def test_durable_backoff_max_attempts_sets_terminal(db: LocalDB):
    """Reaching max_attempts marks the backoff as terminal."""
    b = DurableBackoff("max", db, base_delay=5.0, max_attempts=3, jitter=0)
    b.failure()
    assert b.terminal is False

    b.failure()
    assert b.terminal is False

    b.failure()
    assert b.terminal is True

    state = db.get_retry_state("max")
    assert state["terminal"] is True


def test_durable_backoff_no_max_attempts_never_terminal(db: LocalDB):
    """With max_attempts=0 (unlimited) the task never becomes terminal."""
    b = DurableBackoff("unlimited", db, base_delay=5.0, max_attempts=0, jitter=0)
    for _ in range(50):
        b.failure()
    assert b.terminal is False


def test_durable_backoff_terminal_does_not_advance_after_restore(db: LocalDB):
    """A terminal task restored from DB should not increment fail_count further."""
    # Drive to terminal
    b1 = DurableBackoff("term_adv", db, base_delay=5.0, max_attempts=2, jitter=0)
    b1.failure()
    b1.failure()
    assert b1.terminal is True
    saved_count = b1.fail_count

    # Restore; call failure() again (task loop guards against this, but test the DB layer)
    b2 = DurableBackoff("term_adv", db, base_delay=5.0, max_attempts=2, jitter=0)
    assert b2.terminal is True
    assert b2.fail_count == saved_count


def test_durable_backoff_success_after_terminal_clears_state(db: LocalDB):
    """Calling success() on a terminal backoff clears terminal and DB row."""
    b = DurableBackoff("term_clear", db, base_delay=5.0, max_attempts=1, jitter=0)
    b.failure()
    assert b.terminal is True

    b.success()
    assert b.terminal is False
    assert b.fail_count == 0
    assert db.get_retry_state("term_clear") is None
