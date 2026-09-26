"""Tests for the durable Telegram send queue store."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from talos_agent.adapters.telegram_queue import (
    TelegramQueueBusyError,
    TelegramQueueConfig,
    TelegramQueueConflictError,
    TelegramQueueFullError,
    TelegramSendQueue,
)
from talos_agent.clock import FakeClock
from talos_agent.db import _MIGRATIONS, LocalDB

CHAT = "@testchannel"


def _clock() -> FakeClock:
    return FakeClock(datetime(2026, 9, 24, 12, 0, 0, tzinfo=timezone.utc))


def _queue(tmp_path: Path, clock: FakeClock | None = None, **overrides) -> tuple[TelegramSendQueue, FakeClock, LocalDB]:
    clock = clock or _clock()
    db = LocalDB(path=tmp_path / "queue.db")
    cfg = TelegramQueueConfig(**overrides)
    return TelegramSendQueue(db, cfg, clock=clock), clock, db


def _add(q: TelegramSendQueue, text: str = "hello", **kw):
    return q.enqueue(chat_id=CHAT, kind="post", text=text, **kw)


# ── migration ─────────────────────────────────────────────


def test_migration_creates_queue_tables(tmp_path: Path):
    db = LocalDB(path=tmp_path / "m.db")
    tables = {r[0] for r in db._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"telegram_send_queue", "telegram_rate_state"} <= tables
    assert db._conn.execute("PRAGMA user_version").fetchone()[0] == _MIGRATIONS[-1][0]
    assert _MIGRATIONS[-1][0] >= 11


def test_migration_rejects_invalid_state(tmp_path: Path):
    db = LocalDB(path=tmp_path / "m.db")
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            "INSERT INTO telegram_send_queue (chat_id, kind, text, state, next_attempt_at, created_at, updated_at)"
            " VALUES ('c', 'post', 't', 'bogus', 0, 0, 0)"
        )


def test_upgrade_from_version_10_preserves_existing_data(tmp_path: Path):
    path = tmp_path / "old.db"
    db = LocalDB(path=path)
    db._conn.execute("DROP TABLE telegram_send_queue")
    db._conn.execute("DROP TABLE telegram_rate_state")
    db._conn.execute("INSERT INTO talos_config (key, value) VALUES ('k', 'v')")
    db._conn.execute("PRAGMA user_version = 10")
    db._conn.commit()
    db.close()

    upgraded = LocalDB(path=path)
    assert upgraded._conn.execute("SELECT value FROM talos_config WHERE key='k'").fetchone()[0] == "v"
    assert upgraded._conn.execute("SELECT COUNT(*) FROM telegram_send_queue").fetchone()[0] == 0


# ── config ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "overrides",
    [
        {"min_interval_seconds": -1},
        {"max_per_minute": 0},
        {"max_queue_size": 0},
        {"max_attempts": 0},
        {"max_age_seconds": 0},
        {"backoff_initial": 10, "backoff_max": 1},
        {"retention_seconds": 30},
    ],
)
def test_config_rejects_invalid_values(overrides):
    with pytest.raises(ValueError):
        TelegramQueueConfig(**overrides)


# ── enqueue validation and idempotency ────────────────────


@pytest.mark.parametrize("text", ["", "   ", "x" * 4097])
def test_enqueue_rejects_empty_and_oversized_text(tmp_path, text):
    q, _, _ = _queue(tmp_path)
    with pytest.raises(ValueError):
        _add(q, text)


def test_enqueue_accepts_exact_length_limit(tmp_path):
    q, _, _ = _queue(tmp_path)
    assert _add(q, "x" * 4096).created is True


def test_enqueue_rejects_bad_kind_chat_and_key(tmp_path):
    q, _, _ = _queue(tmp_path)
    with pytest.raises(ValueError):
        q.enqueue(chat_id=CHAT, kind="delete", text="t")
    with pytest.raises(ValueError):
        q.enqueue(chat_id=" ", kind="post", text="t")
    with pytest.raises(ValueError):
        _add(q, dedupe_key="has space")


def test_dedupe_key_returns_existing_row_without_duplicate(tmp_path):
    q, _, _ = _queue(tmp_path)
    first = _add(q, "same", dedupe_key="op-1")
    again = _add(q, "same", dedupe_key="op-1")
    assert first.created and not again.created
    assert first.item_id == again.item_id
    assert q.stats()["counts"]["pending"] == 1


def test_dedupe_key_reuse_with_different_content_conflicts(tmp_path):
    q, _, _ = _queue(tmp_path)
    _add(q, "one", dedupe_key="op-1")
    with pytest.raises(TelegramQueueConflictError):
        _add(q, "two", dedupe_key="op-1")


def test_queue_full_is_explicit_and_boundary_exact(tmp_path):
    q, _, _ = _queue(tmp_path, max_queue_size=2)
    _add(q, "a")
    _add(q, "b")
    with pytest.raises(TelegramQueueFullError):
        _add(q, "c")


# ── ordering and pacing ───────────────────────────────────


def test_claims_are_fifo_and_serialized(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0)
    ids = [_add(q, f"m{i}").item_id for i in range(3)]
    first = q.claim_next().item
    assert first is not None and first.id == ids[0] and first.state == "sending"
    # A message is in flight, so nothing else may be claimed.
    assert q.claim_next().item is None
    q.mark_sent(first.id, 10)
    second = q.claim_next().item
    assert second is not None and second.id == ids[1]


def test_only_id_never_jumps_the_backlog(tmp_path):
    q, _, _ = _queue(tmp_path, min_interval_seconds=0)
    older = _add(q, "older")
    newer = _add(q, "newer")
    assert q.claim_next(only_id=newer.item_id).item is None
    claimed = q.claim_next(only_id=older.item_id).item
    assert claimed is not None and claimed.id == older.item_id


def test_min_interval_boundary(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=1.0)
    _add(q, "a")
    _add(q, "b")
    a = q.claim_next().item
    q.mark_sent(a.id, 1)
    clock.advance(0.99)
    blocked = q.claim_next()
    assert blocked.item is None and blocked.wait_seconds == pytest.approx(0.01, abs=1e-6)
    clock.advance(0.01)
    assert q.claim_next().item is not None


def test_per_minute_cap_boundary(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0, max_per_minute=3)
    for i in range(4):
        _add(q, f"m{i}")
    for _ in range(3):
        item = q.claim_next().item
        assert item is not None
        q.mark_sent(item.id, 1)
        clock.advance(1)
    blocked = q.claim_next()
    assert blocked.item is None
    assert blocked.wait_seconds == pytest.approx(57.0, abs=1e-6)  # first attempt was 3s ago
    clock.advance(56.999)
    assert q.claim_next().item is None
    clock.advance(0.001)
    assert q.claim_next().item is not None


def test_empty_queue_reports_idle(tmp_path):
    q, _, _ = _queue(tmp_path)
    outcome = q.claim_next()
    assert outcome.item is None and outcome.wait_seconds is None


# ── rate-limit block ──────────────────────────────────────


def test_block_chat_delays_claims_and_never_shrinks(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0)
    _add(q, "a")
    q.block_chat(CHAT, 30)
    q.block_chat(CHAT, 5)  # shorter hint must not shorten the existing block
    outcome = q.claim_next()
    assert outcome.item is None and outcome.wait_seconds == pytest.approx(30.0, abs=1e-6)
    clock.advance(30)
    assert q.claim_next().item is not None


def test_block_chat_clamps_absurd_values(tmp_path):
    q, _, _ = _queue(tmp_path)
    q.block_chat(CHAT, 10**12)
    assert q.stats()["rate_limited_for_seconds"] <= 86400.0
    q.block_chat("other", -5)  # negative clamps to "no block"


# ── retry accounting ──────────────────────────────────────


def test_retry_consumes_attempts_until_failed(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0, max_attempts=2, backoff_initial=1, backoff_max=4)
    item_id = _add(q, "x").item_id
    item = q.claim_next().item
    assert q.mark_retry(item.id, q.backoff_delay(item.attempt_count), "server_error") == "pending"
    clock.advance(1)
    item = q.claim_next().item
    assert item.attempt_count == 2
    assert q.mark_retry(item.id, 1, "server_error") == "failed"
    row = q.get(item_id)
    assert row.state == "failed" and row.last_error_code == "max_attempts"


def test_rate_limited_retry_does_not_consume_attempts(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0, max_attempts=1)
    _add(q, "x")
    for _ in range(5):
        item = q.claim_next().item
        assert item is not None and item.attempt_count == 1
        q.mark_retry(item.id, 0, "rate_limited", consume_attempt=False)
        clock.advance(1)


def test_backoff_is_exponential_and_capped(tmp_path):
    q, _, _ = _queue(tmp_path, backoff_initial=2, backoff_max=10)
    assert [q.backoff_delay(n) for n in (0, 1, 2, 3, 4, 5, 500)] == [2, 2, 4, 8, 10, 10, 10]


def test_invalid_error_codes_are_rejected(tmp_path):
    q, _, _ = _queue(tmp_path)
    _add(q)
    item = q.claim_next().item
    with pytest.raises(ValueError):
        q.mark_failed(item.id, "Telegram said: bot123:SECRET")  # free text can never be stored


def test_finishing_an_unclaimed_row_is_refused(tmp_path):
    q, _, _ = _queue(tmp_path)
    item_id = _add(q).item_id
    with pytest.raises(TelegramQueueBusyError):
        q.mark_sent(item_id, 1)


# ── leases, expiry, restart, retention ────────────────────


def test_expired_lease_becomes_indeterminate_and_is_never_resent(tmp_path):
    q, clock, _ = _queue(tmp_path, lease_seconds=30, min_interval_seconds=0)
    item_id = _add(q).item_id
    assert q.claim_next().item is not None
    clock.advance(30)
    outcome = q.claim_next()
    assert outcome.item is None
    row = q.get(item_id)
    assert row.state == "indeterminate" and row.last_error_code == "lease_expired"


def test_pending_messages_expire_by_age(tmp_path):
    q, clock, _ = _queue(tmp_path, max_age_seconds=100)
    item_id = _add(q).item_id
    clock.advance(99.9)
    assert q.get(item_id).state == "pending"
    clock.advance(0.1)
    q.claim_next()
    row = q.get(item_id)
    assert row.state == "failed" and row.last_error_code == "expired"


def test_pending_messages_survive_restart(tmp_path):
    q, clock, db = _queue(tmp_path)
    item_id = _add(q, "durable", dedupe_key="op-9").item_id
    db.close()
    reopened = TelegramSendQueue(LocalDB(path=tmp_path / "queue.db"), q.config, clock=clock)
    assert reopened.get(item_id).text == "durable"
    assert _add(reopened, "durable", dedupe_key="op-9").created is False


def test_prune_keeps_recent_sent_and_all_indeterminate(tmp_path):
    q, clock, _ = _queue(tmp_path, min_interval_seconds=0, lease_seconds=10, retention_seconds=3600)
    old = _add(q, "old").item_id
    q.mark_sent(q.claim_next().item.id, 1)
    stuck = _add(q, "stuck").item_id
    assert q.claim_next().item is not None
    clock.advance(10)
    q.claim_next()  # resolves the lease into 'indeterminate'
    clock.advance(3600)
    recent = _add(q, "recent").item_id
    q.mark_sent(q.claim_next().item.id, 2)
    assert q.prune() == 1
    assert q.get(old) is None
    assert q.get(stuck).state == "indeterminate"
    assert q.get(recent).state == "sent"


def test_stats_contain_counts_but_no_message_text(tmp_path):
    q, clock, _ = _queue(tmp_path)
    _add(q, "private text")
    clock.advance(5)
    stats = q.stats()
    assert stats["counts"]["pending"] == 1
    assert stats["oldest_unsent_age_seconds"] == pytest.approx(5.0)
    assert "private text" not in repr(stats)


# ── settings ──────────────────────────────────────────────


def test_settings_default_to_queue_disabled_with_telegram_limits():
    from talos_agent.config import Settings

    settings = Settings()
    assert settings.telegram_rate_limit_enabled is False
    cfg = TelegramQueueConfig.from_settings(settings)
    assert cfg.min_interval_seconds == 1.0 and cfg.max_per_minute == 20


def test_settings_read_environment_and_validate_bounds(monkeypatch):
    from pydantic import ValidationError

    from talos_agent.config import Settings

    monkeypatch.setenv("TALOS_TELEGRAM_RATE_LIMIT_ENABLED", "true")
    monkeypatch.setenv("TALOS_TELEGRAM_MAX_PER_MINUTE", "5")
    settings = Settings()
    assert settings.telegram_rate_limit_enabled is True
    assert TelegramQueueConfig.from_settings(settings).max_per_minute == 5

    monkeypatch.setenv("TALOS_TELEGRAM_MAX_PER_MINUTE", "0")
    with pytest.raises(ValidationError):
        Settings()
