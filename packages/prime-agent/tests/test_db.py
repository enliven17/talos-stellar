"""Tests for LocalDB — SQLite schema, queries, lifecycles."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from talos_agent.db import LocalDB


def test_all_tables_exist(mock_db: LocalDB):
    """All expected tables are created on init."""
    tables = {
        row[0]
        for row in mock_db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }
    expected = {
        "schedules", "activity_log", "content_history", "commerce_queue",
        "approval_cache", "spending_log", "talos_config", "playbooks",
        "content_performance", "strategy_learnings", "audience_insights",
    }
    assert expected.issubset(tables), f"Missing tables: {expected - tables}"


def test_wal_mode(mock_db: LocalDB):
    mode = mock_db._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"


class TestCountToday:
    def test_empty_returns_zero(self, mock_db: LocalDB):
        assert mock_db.count_today("post") == 0

    def test_counts_correct_type(self, mock_db: LocalDB):
        mock_db.add_activity("post", "hello", "X")
        mock_db.add_activity("post", "world", "X")
        mock_db.add_activity("research", "notes", "web")
        assert mock_db.count_today("post") == 2
        assert mock_db.count_today("research") == 1


class TestSpendingPeriod:
    def test_empty_returns_zero(self, mock_db: LocalDB):
        assert mock_db.get_spending_period(30) == 0.0

    def test_sums_within_range(self, mock_db: LocalDB):
        mock_db.record_spending(10.0, "x402_purchase", "svc A")
        mock_db.record_spending(5.5, "x402_purchase", "svc B")
        assert mock_db.get_spending_period(30) == 15.5

    def test_excludes_old_records(self, mock_db: LocalDB):
        mock_db.record_spending(100.0, "old", "ancient purchase")
        # Backdate the record to 60 days ago
        mock_db._conn.execute(
            "UPDATE spending_log SET created_at = datetime('now', '-60 days')"
        )
        mock_db._conn.commit()
        assert mock_db.get_spending_period(30) == 0.0


class TestCommerceLifecycle:
    def test_add_and_update(self, mock_db: LocalDB):
        mock_db.add_commerce_job("job-1", "talos-a", "trend_research", {"q": "AI"})
        mock_db.update_commerce_status("job-1", "completed")
        row = mock_db._conn.execute(
            "SELECT status FROM commerce_queue WHERE job_id = 'job-1'"
        ).fetchone()
        assert row["status"] == "completed"

    def test_duplicate_ignored(self, mock_db: LocalDB):
        mock_db.add_commerce_job("job-dup", "c1", "svc")
        mock_db.add_commerce_job("job-dup", "c2", "svc2")  # Should be ignored
        rows = mock_db._conn.execute(
            "SELECT * FROM commerce_queue WHERE job_id = 'job-dup'"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["talos_id"] == "c1"


class TestLearningsLifecycle:
    def test_save_returns_id(self, mock_db: LocalDB):
        lid = mock_db.save_learning("content", "short posts work better", "data", 0.8)
        assert isinstance(lid, int)
        assert lid > 0

    def test_get_active_learnings(self, mock_db: LocalDB):
        mock_db.save_learning("content", "insight A", confidence=0.9)
        learnings = mock_db.get_active_learnings(10)
        assert len(learnings) >= 1
        assert learnings[0]["insight"] == "insight A"

    def test_expired_excluded(self, mock_db: LocalDB):
        lid = mock_db.save_learning("old", "stale insight", confidence=0.5, expires_days=1)
        # Backdate expiry
        mock_db._conn.execute(
            "UPDATE strategy_learnings SET expires_at = datetime('now', '-2 days') WHERE id = ?",
            (lid,),
        )
        mock_db._conn.commit()
        learnings = mock_db.get_active_learnings(10)
        assert all(l["insight"] != "stale insight" for l in learnings)

    def test_ordered_by_confidence(self, mock_db: LocalDB):
        mock_db.save_learning("a", "low", confidence=0.3)
        mock_db.save_learning("b", "high", confidence=0.9)
        mock_db.save_learning("c", "mid", confidence=0.6)
        learnings = mock_db.get_active_learnings(10)
        confidences = [l["confidence"] for l in learnings]
        assert confidences == sorted(confidences, reverse=True)
