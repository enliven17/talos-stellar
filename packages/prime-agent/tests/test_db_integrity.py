from __future__ import annotations

import sqlite3

from talos_agent.db import LocalDB
from talos_agent.db.integrity import check_agent_databases, check_agent_database


def test_integrity_checks_are_read_only_and_report_schema(tmp_path):
    path = tmp_path / "agent-alpha.db"
    db = LocalDB(path=path)
    db.close()
    before = path.stat().st_mtime_ns

    report = check_agent_database(path)

    assert report.status == "healthy"
    assert report.agent_id == "alpha"
    assert report.quick_check == "ok"
    assert report.missing_tables == ()
    assert path.stat().st_mtime_ns == before


def test_one_corrupt_agent_does_not_hide_healthy_agent(tmp_path):
    healthy = tmp_path / "agent-good.db"
    db = LocalDB(path=healthy)
    db.close()
    (tmp_path / "agent-bad.db").write_bytes(b"not sqlite")

    reports = {report.agent_id: report for report in check_agent_databases(tmp_path)}

    assert reports["good"].status == "healthy"
    assert reports["bad"].status == "error"


def test_schema_inspection_reports_missing_column(tmp_path):
    path = tmp_path / "talos-agent.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE schedules (task_name TEXT PRIMARY KEY)")
    conn.commit()
    conn.close()

    report = check_agent_database(path)

    assert report.status == "degraded"
    assert "schedules.last_run_at" in report.missing_columns
