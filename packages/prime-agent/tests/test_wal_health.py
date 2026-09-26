"""Tests for SQLite WAL health diagnostics."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from talos_agent.db import LocalDB
from talos_agent.wal_health import WalHealthState, collect_wal_health


def test_localdb_wal_health_healthy(mock_db: LocalDB):
    report = mock_db.wal_health()
    assert report.state == WalHealthState.HEALTHY
    assert report.journal_mode == "wal"
    assert report.integrity == "ok"
    assert report.db_basename.endswith(".db")
    payload = report.to_dict()
    assert payload["state"] == "healthy"
    assert "db_basename" in payload
    # Privacy: full path must not appear in serialized output.
    assert "/" not in payload["db_basename"]
    assert "\\" not in payload["db_basename"]


def test_collect_missing_database(tmp_path: Path):
    missing = tmp_path / "absent.db"
    report = collect_wal_health(missing)
    assert report.state == WalHealthState.MISSING
    assert "db_missing" in report.findings
    assert report.db_basename == "absent.db"


def test_collect_no_input():
    report = collect_wal_health(None)
    assert report.state == WalHealthState.ERROR
    assert "missing_input" in report.findings


def test_collect_directory_not_file(tmp_path: Path):
    report = collect_wal_health(tmp_path)
    assert report.state == WalHealthState.ERROR
    assert "db_not_file" in report.findings


def test_non_wal_mode_degraded(tmp_path: Path):
    path = tmp_path / "delete.db"
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("CREATE TABLE t (id INTEGER)")
    conn.commit()
    # Reuse connection so we observe DELETE mode (LocalDB forces WAL).
    report = collect_wal_health(path, conn=conn, run_checkpoint=False)
    conn.close()
    assert report.state == WalHealthState.DEGRADED
    assert report.journal_mode == "delete"
    assert any(f.startswith("journal_mode_") for f in report.findings)


def test_readonly_path_collection(tmp_path: Path):
    path = tmp_path / "ro.db"
    db = LocalDB(path=path)
    db.close()
    report = collect_wal_health(path)
    assert report.state == WalHealthState.HEALTHY
    assert report.journal_mode == "wal"


def test_quick_check_skipped(mock_db: LocalDB):
    report = mock_db.wal_health(run_quick_check=False, run_checkpoint=False)
    assert report.state == WalHealthState.HEALTHY
    assert report.integrity is None
    assert report.checkpoint_busy is None
