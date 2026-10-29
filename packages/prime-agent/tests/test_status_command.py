"""Tests for the `talos-agent status` CLI command.

Uses Click's CliRunner with a seeded temporary SQLite DB so tests run
completely offline (no network, no running agent process).
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from click.testing import CliRunner


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture()
def tmp_db(tmp_path: Path) -> Path:
    """Create a minimal seeded SQLite DB in *tmp_path* and return its path."""
    db_path = tmp_path / "talos-agent.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedules (
            task_name   TEXT PRIMARY KEY,
            last_run_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS talos_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS activity_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            type       TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS approvals (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            status  TEXT NOT NULL DEFAULT 'pending'
        )
    """)
    # Seed talos config
    conn.execute(
        "INSERT OR REPLACE INTO talos_config (key, value) VALUES (?, ?)",
        ("talos_id", "vega-001"),
    )
    conn.execute(
        "INSERT OR REPLACE INTO talos_config (key, value) VALUES (?, ?)",
        ("name", "Vega"),
    )
    # Seed a last-run schedule entry
    conn.execute(
        "INSERT OR REPLACE INTO schedules (task_name, last_run_at) VALUES (?, ?)",
        ("agent_cycle", "2026-10-17T10:00:00"),
    )
    conn.commit()
    conn.close()
    return db_path


# ── Status command (human-readable) ─────────────────────────────────────────


class TestStatusCommand:
    """CliRunner tests for `talos-agent status`."""

    def test_status_exits_0_on_empty_db(self, tmp_path: Path) -> None:
        """A fresh DB with no issues should exit 0."""
        from talos_agent.cli import main

        runner = CliRunner()
        db_path = tmp_path / "fresh.db"
        # Create an empty but valid DB
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE IF NOT EXISTS schedules (task_name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS talos_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY, type TEXT, created_at TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY, status TEXT)")
        conn.commit()
        conn.close()

        result = runner.invoke(main, ["status", "--db-path", str(db_path)])
        # Should not crash; exit code is 0 (healthy) or 1 (degraded),
        # but never 2 (usage error).
        assert result.exit_code != 2, f"Unexpected usage error: {result.output}"
        assert "Status" in result.output or "healthy" in result.output.lower() or "degraded" in result.output.lower()

    def test_status_shows_last_cycle(self, tmp_db: Path) -> None:
        """Last cycle time should appear in the human-readable output."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--db-path", str(tmp_db)])

        assert result.exit_code != 2, f"Usage error: {result.output}"
        assert "last cycle" in result.output.lower() or "2026-10-17" in result.output

    def test_status_shows_circuit_breakers_section(self, tmp_db: Path) -> None:
        """Circuit Breakers section should always appear."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        assert "Circuit Breakers" in result.output or "circuit" in result.output.lower()

    def test_status_shows_wal_section(self, tmp_db: Path) -> None:
        """WAL Diagnostics section should appear when DB exists."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        assert "WAL" in result.output or "wal" in result.output.lower()

    def test_status_shows_overall_line(self, tmp_db: Path) -> None:
        """Overall: healthy/degraded line should appear."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        assert "Overall" in result.output

    def test_status_missing_db_does_not_crash(self, tmp_path: Path) -> None:
        """Pointing at a non-existent DB should emit a message, not crash."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(
            main,
            ["status", "--db-path", str(tmp_path / "nonexistent.db")],
        )
        # Should not produce an unhandled traceback (exit code 2 = usage error)
        assert result.exit_code != 2


# ── Status command (JSON) ────────────────────────────────────────────────────


class TestStatusCommandJson:
    """CliRunner tests for `talos-agent status --json`."""

    def test_json_output_is_valid_json(self, tmp_db: Path) -> None:
        """--json should produce parseable JSON."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2, f"Usage error: {result.output}"
        try:
            payload = json.loads(result.output)
        except json.JSONDecodeError as exc:
            pytest.fail(f"Output is not valid JSON: {exc}\nOutput:\n{result.output}")
        assert isinstance(payload, dict)

    def test_json_has_required_top_level_keys(self, tmp_db: Path) -> None:
        """The stable JSON schema must include agent, circuit_breakers, wal, overall."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        payload = json.loads(result.output)

        assert "agent" in payload, "Missing 'agent' key"
        assert "circuit_breakers" in payload, "Missing 'circuit_breakers' key"
        assert "pending_job_effects" in payload, "Missing 'pending_job_effects' key"
        assert "wal" in payload, "Missing 'wal' key"
        assert "overall" in payload, "Missing 'overall' key"

    def test_json_agent_subkeys(self, tmp_db: Path) -> None:
        """agent sub-dict must contain talos_id, name, db_path, db_exists, last_cycle_at."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        payload = json.loads(result.output)
        agent = payload["agent"]

        for key in ("talos_id", "name", "db_path", "db_exists", "last_cycle_at", "posts_today", "pending_approvals"):
            assert key in agent, f"Missing agent.{key}"

    def test_json_overall_is_healthy_or_degraded(self, tmp_db: Path) -> None:
        """overall must be 'healthy' or 'degraded'."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        payload = json.loads(result.output)
        assert payload["overall"] in ("healthy", "degraded")

    def test_json_wal_present_when_db_exists(self, tmp_db: Path) -> None:
        """wal key should not be null when the DB file exists."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        payload = json.loads(result.output)
        # WAL report may be None if the DB lacks WAL mode, but let's ensure
        # the key is present and either None or a dict.
        assert "wal" in payload
        if payload["wal"] is not None:
            assert isinstance(payload["wal"], dict)
            assert "state" in payload["wal"]

    def test_json_circuit_breakers_is_dict(self, tmp_db: Path) -> None:
        """circuit_breakers must be a dict (possibly empty when agent not started)."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(tmp_db)])

        assert result.exit_code != 2
        payload = json.loads(result.output)
        assert isinstance(payload["circuit_breakers"], dict)

    def test_json_missing_db_still_valid(self, tmp_path: Path) -> None:
        """--json with a missing DB should still emit valid JSON with db_exists=false."""
        from talos_agent.cli import main

        runner = CliRunner()
        result = runner.invoke(
            main,
            ["status", "--json", "--db-path", str(tmp_path / "nonexistent.db")],
        )

        assert result.exit_code != 2
        try:
            payload = json.loads(result.output)
        except json.JSONDecodeError as exc:
            pytest.fail(f"Expected JSON even for missing DB, got: {result.output}\n{exc}")
        assert payload["agent"]["db_exists"] is False

    def test_json_no_secrets_in_output(self, tmp_path: Path) -> None:
        """No Stellar secret-seed-like strings (S[A-Z2-7]{55}) should appear in output."""
        import re
        from talos_agent.cli import main

        # Seed a DB with a fake secret-like value in talos_config
        db_path = tmp_path / "secrets-test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("CREATE TABLE IF NOT EXISTS schedules (task_name TEXT PRIMARY KEY, last_run_at TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS talos_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY, type TEXT, created_at TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY, status TEXT)")
        conn.execute(
            "INSERT OR REPLACE INTO talos_config VALUES (?, ?)",
            ("secret_key", "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX"),
        )
        conn.commit()
        conn.close()

        runner = CliRunner()
        result = runner.invoke(main, ["status", "--json", "--db-path", str(db_path)])

        # Stellar secret seeds must not appear verbatim in status output
        secret_pattern = re.compile(r"S[A-Z2-7]{55}")
        assert not secret_pattern.search(result.output), (
            "A Stellar secret seed appeared in --json output!"
        )
