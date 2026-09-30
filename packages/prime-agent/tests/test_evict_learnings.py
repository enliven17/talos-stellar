"""Tests for expired learning memory eviction."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def _db(tmp_path: Path):
    from talos_agent.db import LocalDB

    path = tmp_path / "talos-agent.db"
    return LocalDB(path)


def test_evict_expired_learnings_removes_only_expired(tmp_path: Path):
    db = _db(tmp_path)
    keep_id = db.save_learning("tone", "keep me", expires_days=30)
    # Insert an already-expired row directly.
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    db._conn.execute(
        "INSERT INTO strategy_learnings (category, insight, evidence, confidence, expires_at) "
        "VALUES (?, ?, ?, ?, ?)",
        ("tone", "drop me", "", 0.5, past),
    )
    db._conn.commit()
    expired_id = db._conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    result = db.evict_expired_learnings()
    assert result["evicted"] == 1
    assert expired_id in result["ids"]
    assert keep_id not in result["ids"]

    active = db.get_active_learnings(10)
    assert any(r["id"] == keep_id for r in active)
    assert all(r["id"] != expired_id for r in active)


def test_evict_expired_learnings_keeps_null_ttl(tmp_path: Path):
    db = _db(tmp_path)
    forever = db.save_learning("seg", "no ttl", expires_days=None)
    result = db.evict_expired_learnings()
    assert result["evicted"] == 0
    assert any(r["id"] == forever for r in db.get_active_learnings(10))
