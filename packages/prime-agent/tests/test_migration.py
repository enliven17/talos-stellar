"""Tests for SQLite Schema versioning and migration runner."""

from __future__ import annotations

import sqlite3
from pathlib import Path
import pytest

from talos_agent.db import LocalDB, _MIGRATIONS


def test_fresh_database(tmp_path: Path):
    """Test that a brand new database runs all migrations and tables exist."""
    db_file = tmp_path / "fresh.db"
    db = LocalDB(path=db_file)

    # 1. Verify tables exist
    cursor = db._conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    tables = {row[0] for row in cursor.fetchall()}
    expected_tables = {
        "schedules", "activity_log", "content_history", "commerce_queue",
        "approval_cache", "spending_log", "talos_config", "playbooks",
        "content_performance", "strategy_learnings", "audience_insights"
    }
    assert expected_tables.issubset(tables), f"Missing tables: {expected_tables - tables}"

    # 2. Verify user_version equals the latest migration version
    cursor.execute("PRAGMA user_version;")
    version = cursor.fetchone()[0]
    latest_migration_version = _MIGRATIONS[-1][0]
    assert version == latest_migration_version

    db.close()


def test_incremental_upgrade(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test that an existing database increments its user_version and runs pending migrations."""
    db_file = tmp_path / "upgrade.db"

    # Define custom migrations for controlled testing
    custom_migrations = [
        (1, """
        CREATE TABLE test_table_1 (
            id INTEGER PRIMARY KEY
        );
        """),
        (2, """
        CREATE TABLE test_table_2 (
            id INTEGER PRIMARY KEY
        );
        """),
        (3, """
        ALTER TABLE test_table_2 ADD COLUMN new_col TEXT;
        """)
    ]
    monkeypatch.setattr("talos_agent.db._MIGRATIONS", custom_migrations)

    # Simulate database manually at version 1 (already executed table 1, user_version = 1)
    conn = sqlite3.connect(str(db_file))
    conn.execute("CREATE TABLE test_table_1 (id INTEGER PRIMARY KEY);")
    conn.execute("PRAGMA user_version = 1;")
    conn.commit()
    conn.close()

    # Initialize LocalDB
    db = LocalDB(path=db_file)

    # Verify version has been incremented to the latest custom migration (3)
    cursor = db._conn.cursor()
    cursor.execute("PRAGMA user_version;")
    version = cursor.fetchone()[0]
    assert version == 3

    # Verify that test_table_2 exists and has new_col
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table_2'")
    assert cursor.fetchone() is not None

    cursor.execute("PRAGMA table_info(test_table_2)")
    cols = {row[1] for row in cursor.fetchall()}
    assert "new_col" in cols

    db.close()


def test_migration_idempotency(tmp_path: Path):
    """Test that running migrations on an already upgraded database is a no-op."""
    db_file = tmp_path / "idempotency.db"

    # First initialization
    db = LocalDB(path=db_file)
    cursor = db._conn.cursor()
    cursor.execute("PRAGMA user_version;")
    version_initial = cursor.fetchone()[0]
    db.close()

    # Second initialization
    db_reopened = LocalDB(path=db_file)
    cursor_reopened = db_reopened._conn.cursor()
    cursor_reopened.execute("PRAGMA user_version;")
    version_reopened = cursor_reopened.fetchone()[0]

    assert version_initial == version_reopened
    db_reopened.close()


def test_transaction_safety(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test that a failing migration rolls back the entire batch and leaves user_version unchanged."""
    db_file = tmp_path / "safety.db"

    # Define custom migrations where the second one will fail
    custom_migrations = [
        (1, """
        CREATE TABLE test_t1 (
            id INTEGER PRIMARY KEY
        );
        """),
        (2, """
        CREATE TABLE test_t2 (
            id INTEGER PRIMARY KEY
        );
        -- Intentionally failing statement
        INSERT INTO non_existent_table (col) VALUES (1);
        """)
    ]
    monkeypatch.setattr("talos_agent.db._MIGRATIONS", custom_migrations)

    # LocalDB init should raise sqlite3.OperationalError due to the invalid statement
    with pytest.raises(sqlite3.OperationalError):
        LocalDB(path=db_file)

    # Verify database state was fully rolled back
    conn = sqlite3.connect(str(db_file))
    cursor = conn.cursor()

    # 1. user_version should be unchanged (0)
    cursor.execute("PRAGMA user_version;")
    assert cursor.fetchone()[0] == 0

    # 2. test_t1 should NOT exist since the transaction was rolled back
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='test_t1'")
    assert cursor.fetchone() is None

    conn.close()
