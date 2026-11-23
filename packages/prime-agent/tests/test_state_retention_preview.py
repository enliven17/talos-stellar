"""Tests for local state retention preview by record class (#1451).

Verifies:
- Candidate counts and date boundaries are correctly reported per table and class.
- Separation of private content from financial and audit records.
- Filtering by specific record class.
- Candidate count and boundaries filtering with cutoff_iso.
- Read-only preservation of live database rows (no deletion or modification).
- Graceful handling of empty or missing tables.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from talos_agent.backup_service import BackupError, preview_database_retention
from talos_agent.db import LocalDB
from talos_agent.db.retention import (
    RecordClass,
)


def _seed_sample_records(db: LocalDB) -> None:
    """Seed various record classes: private content, financial, audit, operational."""
    conn = db._conn

    # 1. Private Content: activity_log & content_history
    conn.execute(
        "INSERT INTO activity_log (type, content, channel, status, created_at) "
        "VALUES ('post', 'Draft content alpha', 'twitter', 'sent', '2026-01-10T10:00:00Z')"
    )
    conn.execute(
        "INSERT INTO activity_log (type, content, channel, status, created_at) "
        "VALUES ('post', 'Draft content beta', 'twitter', 'sent', '2026-03-15T12:00:00Z')"
    )
    conn.execute(
        "INSERT INTO content_history (content, channel, posted_at) "
        "VALUES ('Published campaign text', 'discord', '2026-02-01T08:00:00Z')"
    )

    # 2. Financial: spending_log, loans, dividends_log
    conn.execute(
        "INSERT INTO spending_log (amount, currency, category, description, created_at) "
        "VALUES (15.5, 'USDC', 'compute', 'Inference fee', '2026-01-05T09:00:00Z')"
    )
    conn.execute(
        "INSERT INTO spending_log (amount, currency, category, description, created_at) "
        "VALUES (42.0, 'USDC', 'oracle', 'Data feed subscription', '2026-04-01T11:00:00Z')"
    )
    conn.execute(
        "INSERT INTO dividends_log (spending_log_id, recipient_address, token_symbol, amount, status, created_at) "
        "VALUES (1, 'GABC...123', 'USDC', 10.0, 'completed', '2026-02-15T14:00:00Z')"
    )

    # 3. Audit: secret_audit_events
    conn.execute(
        "INSERT INTO secret_audit_events (event_id, scope, name, version, event_type, outcome, actor, created_at) "
        "VALUES ('evt-1', 'global', 'TALOS_API_KEY', 1, 'rotate', 'success', 'operator', '2026-01-01T00:00:00Z')"
    )
    conn.execute(
        "INSERT INTO secret_audit_events (event_id, scope, name, version, event_type, outcome, actor, created_at) "
        "VALUES ('evt-2', 'global', 'TALOS_API_KEY', 2, 'rotate', 'success', 'operator', '2026-05-01T00:00:00Z')"
    )

    # 4. Operational: completion_markers
    conn.execute(
        "INSERT INTO completion_markers (job_id, idempotency_key, completed_at, expires_at) "
        "VALUES ('job-1', 'key-abc', '2026-03-01T10:00:00Z', '2026-03-08T10:00:00Z')"
    )

    conn.commit()


def test_preview_retention_separates_record_classes(tmp_path: Path):
    db_path = tmp_path / "test-agent.db"
    db = LocalDB(db_path)
    _seed_sample_records(db)

    report = db.preview_retention()
    summary = report.summary_by_class

    # Verify categories exist in summary
    assert RecordClass.PRIVATE_CONTENT.value in summary
    assert RecordClass.FINANCIAL.value in summary
    assert RecordClass.AUDIT.value in summary
    assert RecordClass.OPERATIONAL.value in summary

    # Verify counts and boundary dates for Private Content
    private_summary = summary[RecordClass.PRIVATE_CONTENT.value]
    assert private_summary["total_records"] == 3
    assert private_summary["oldest_boundary"] == "2026-01-10T10:00:00Z"
    assert private_summary["newest_boundary"] == "2026-03-15T12:00:00Z"

    # Verify counts and boundary dates for Financial Records
    financial_summary = summary[RecordClass.FINANCIAL.value]
    assert financial_summary["total_records"] == 3
    assert financial_summary["oldest_boundary"] == "2026-01-05T09:00:00Z"
    assert financial_summary["newest_boundary"] == "2026-04-01T11:00:00Z"

    # Verify counts and boundary dates for Audit Records
    audit_summary = summary[RecordClass.AUDIT.value]
    assert audit_summary["total_records"] == 2
    assert audit_summary["oldest_boundary"] == "2026-01-01T00:00:00Z"
    assert audit_summary["newest_boundary"] == "2026-05-01T00:00:00Z"

    # Ensure live database was completely preserved (read-only)
    cur = db._conn.cursor()
    assert cur.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0] == 2
    assert cur.execute("SELECT COUNT(*) FROM spending_log").fetchone()[0] == 2
    assert cur.execute("SELECT COUNT(*) FROM secret_audit_events").fetchone()[0] == 2


def test_preview_retention_filters_by_record_class(tmp_path: Path):
    db_path = tmp_path / "test-agent.db"
    db = LocalDB(db_path)
    _seed_sample_records(db)

    # Filter only FINANCIAL
    fin_report = db.preview_retention(record_class=RecordClass.FINANCIAL.value)
    for tbl in fin_report.tables:
        assert tbl.record_class == RecordClass.FINANCIAL

    # Filter only PRIVATE_CONTENT
    priv_report = db.preview_retention(record_class=RecordClass.PRIVATE_CONTENT.value)
    for tbl in priv_report.tables:
        assert tbl.record_class == RecordClass.PRIVATE_CONTENT


def test_preview_retention_with_cutoff(tmp_path: Path):
    db_path = tmp_path / "test-agent.db"
    db = LocalDB(db_path)
    _seed_sample_records(db)

    # Cutoff at 2026-02-10:
    # activity_log: '2026-01-10T10:00:00Z' is before cutoff (1 candidate); '2026-03-15...' is after
    # content_history: '2026-02-01T08:00:00Z' is before cutoff (1 candidate)
    cutoff = "2026-02-10T00:00:00Z"
    report = db.preview_retention(cutoff_iso=cutoff)

    table_map = {t.table: t for t in report.tables}

    act_tbl = table_map["activity_log"]
    assert act_tbl.total_count == 2
    assert act_tbl.candidate_count == 1
    assert act_tbl.oldest_candidate == "2026-01-10T10:00:00Z"
    assert act_tbl.newest_candidate == "2026-01-10T10:00:00Z"

    spend_tbl = table_map["spending_log"]
    assert spend_tbl.total_count == 2
    assert spend_tbl.candidate_count == 1
    assert spend_tbl.oldest_candidate == "2026-01-05T09:00:00Z"

    # Ensure no rows were altered
    assert db._conn.execute("SELECT COUNT(*) FROM activity_log").fetchone()[0] == 2


def test_preview_database_retention_backup_service_helper(tmp_path: Path):
    db_path = tmp_path / "agent-helper.db"
    db = LocalDB(db_path)
    _seed_sample_records(db)
    db.close()

    # Call through backup_service.preview_database_retention
    report = preview_database_retention(db_path=db_path)
    assert report.summary_by_class["financial"]["total_records"] == 3

    # Non-existent DB raises BackupError
    with pytest.raises(BackupError) as exc_info:
        preview_database_retention(db_path=tmp_path / "non-existent.db")
    assert exc_info.value.code == "BAD_INPUT"


def test_preview_table_retention_empty_database(tmp_path: Path):
    db_path = tmp_path / "empty.db"
    db = LocalDB(db_path)
    report = db.preview_retention()

    for tbl in report.tables:
        assert tbl.total_count == 0
        assert tbl.candidate_count == 0
        assert tbl.oldest_candidate is None
        assert tbl.newest_candidate is None

    for class_summary in report.summary_by_class.values():
        assert class_summary["total_records"] == 0
        assert class_summary["candidate_records"] == 0
        assert class_summary["oldest_boundary"] is None
        assert class_summary["newest_boundary"] is None
