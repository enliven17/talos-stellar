"""Tests for restore dry-run state diff (#542).

Covers:
- Positive dry-run producing a privacy-safe state diff without commit.
- Negative/malformed inputs still raise preflight errors.
- Boundary: missing active DB treated as empty; sensitive keys redacted.
- Regression: dry-run leaves active state untouched and cleans staged files.
- CLI `--dry-run --json` output includes state_diff and committed=false.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from talos_agent.checkpoint_cli import checkpoint, CheckpointExitCode
from talos_agent.db import LocalDB
from talos_agent.restore import (
    PreflightError,
    StagedRestoreConfig,
    compute_restore_state_diff,
    perform_restore_dry_run,
    perform_restore_dry_run_sync,
    perform_staged_restore,
)


@pytest.fixture
def target_db(tmp_path: Path) -> Path:
    db_file = tmp_path / "agent-test_agent.db"
    db = LocalDB(path=db_file)
    db._conn.execute(
        "INSERT INTO schedules (task_name, last_run_at) VALUES ('active_task', '2026-01-01T00:00:00Z')"
    )
    db._conn.execute(
        "INSERT OR REPLACE INTO talos_config (key, value) VALUES ('theme', 'dark')"
    )
    db._conn.execute(
        "INSERT OR REPLACE INTO talos_config (key, value) VALUES ('api_token', 'super-secret-token')"
    )
    db._conn.commit()
    db.close()
    return db_file


@pytest.fixture
def valid_checkpoint_file(tmp_path: Path) -> Path:
    cp_path = tmp_path / "valid_checkpoint.json"
    data = {
        "schema_version": 1,
        "agent_id": "test_agent",
        "tables": {"schedules": 2, "activity_log": 0},
        "tables_data": {
            "schedules": [
                {"task_name": "task1", "last_run_at": "2026-07-20T10:00:00Z"},
                {"task_name": "task2", "last_run_at": "2026-07-21T12:00:00Z"},
            ],
            "talos_config": [
                {"key": "theme", "value": "light"},
                {"key": "api_token", "value": "rotated-secret"},
            ],
        },
    }
    cp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return cp_path


class TestRestoreDryRunPositive:
    @pytest.mark.asyncio
    async def test_dry_run_returns_state_diff_without_commit(
        self, target_db: Path, valid_checkpoint_file: Path
    ):
        before = target_db.read_bytes()
        res = await perform_restore_dry_run(
            target_db_path=target_db,
            checkpoint_input=valid_checkpoint_file,
            agent_id="test_agent",
        )

        assert res.dry_run is True
        assert res.committed is False
        assert res.preflight_passed is True
        assert res.state_diff is not None
        assert res.state_diff.would_commit is True
        assert "schedules" in res.state_diff.tables_changed
        schedules = next(t for t in res.state_diff.tables if t.table == "schedules")
        assert schedules.before_count == 1
        assert schedules.after_count == 2
        assert "task1" in schedules.added_keys
        assert "active_task" in schedules.removed_keys

        # Active DB unchanged
        assert target_db.read_bytes() == before
        # No leftover staged files
        staged = list(target_db.parent.glob(f"{target_db.name}.staged.*.db"))
        assert staged == []

    def test_dry_run_sync_helper(self, target_db: Path, valid_checkpoint_file: Path):
        res = perform_restore_dry_run_sync(
            target_db_path=target_db,
            checkpoint_input=valid_checkpoint_file,
            agent_id="test_agent",
        )
        assert res.dry_run is True
        assert res.committed is False
        assert res.state_diff is not None


class TestRestoreDryRunNegative:
    @pytest.mark.asyncio
    async def test_missing_checkpoint_raises_preflight(self, target_db: Path):
        with pytest.raises(PreflightError, match="Checkpoint file not found"):
            await perform_restore_dry_run(
                target_db_path=target_db,
                checkpoint_input=target_db.parent / "missing.json",
                agent_id="test_agent",
            )

    @pytest.mark.asyncio
    async def test_agent_mismatch_raises_preflight(
        self, target_db: Path, valid_checkpoint_file: Path
    ):
        with pytest.raises(PreflightError, match="does not match expected"):
            await perform_restore_dry_run(
                target_db_path=target_db,
                checkpoint_input=valid_checkpoint_file,
                agent_id="other_agent",
                config=StagedRestoreConfig(require_agent_match=True, dry_run=True),
            )


class TestRestoreDryRunBoundary:
    @pytest.mark.asyncio
    async def test_missing_active_db_treated_as_empty(
        self, tmp_path: Path, valid_checkpoint_file: Path
    ):
        missing_db = tmp_path / "agent-fresh.db"
        res = await perform_restore_dry_run(
            target_db_path=missing_db,
            checkpoint_input=valid_checkpoint_file,
            agent_id="test_agent",
        )
        assert res.dry_run is True
        assert res.committed is False
        assert missing_db.exists() is False
        assert res.state_diff is not None
        assert res.state_diff.total_rows_before == 0
        assert res.state_diff.total_rows_after > 0

    def test_sensitive_keys_are_redacted(self, target_db: Path, tmp_path: Path):
        # Build staged DB manually to exercise compute_restore_state_diff redaction
        staged = tmp_path / "staged.db"
        db = LocalDB(path=staged)
        db._conn.execute(
            "INSERT OR REPLACE INTO talos_config (key, value) VALUES ('api_token', 'new-secret')"
        )
        db._conn.execute(
            "INSERT OR REPLACE INTO talos_config (key, value) VALUES ('theme', 'light')"
        )
        db._conn.commit()
        db.close()

        diff = compute_restore_state_diff(target_db, staged)
        cfg = next(t for t in diff.tables if t.table == "talos_config")
        # Sensitive key name must be redacted; raw secret values must never appear
        blob = json.dumps(diff.to_dict())
        assert "super-secret-token" not in blob
        assert "new-secret" not in blob
        assert "rotated-secret" not in blob
        assert any(k.startswith("<redacted:") for k in (cfg.added_keys + cfg.removed_keys + cfg.changed_keys + [cfg.table]))
        # theme may show as changed (value dark->light) without exposing values
        assert "theme" in cfg.changed_keys or "theme" in cfg.added_keys or cfg.delta != 0


class TestRestoreDryRunRegression:
    @pytest.mark.asyncio
    async def test_config_dry_run_flag_on_perform_staged_restore(
        self, target_db: Path, valid_checkpoint_file: Path
    ):
        before_rows = sqlite3.connect(str(target_db)).execute(
            "SELECT task_name FROM schedules"
        ).fetchall()
        res = await perform_staged_restore(
            target_db_path=target_db,
            checkpoint_input=valid_checkpoint_file,
            agent_id="test_agent",
            config=StagedRestoreConfig(dry_run=True),
        )
        after_rows = sqlite3.connect(str(target_db)).execute(
            "SELECT task_name FROM schedules"
        ).fetchall()
        assert res.dry_run is True
        assert res.committed is False
        assert before_rows == after_rows


class TestCheckpointCLIDryRun:
    def test_cli_dry_run_json(self, tmp_path: Path, valid_checkpoint_file: Path):
        runner = CliRunner()
        with patch("talos_agent.db.APP_DIR", tmp_path):
            # Seed an active DB under APP_DIR so diff is non-empty
            from talos_agent.db import get_db_path, LocalDB as LDB

            db_path = get_db_path("test_agent")
            db = LDB(path=db_path)
            db._conn.execute(
                "INSERT INTO schedules (task_name, last_run_at) VALUES ('active_task', '2026-01-01T00:00:00Z')"
            )
            db._conn.commit()
            db.close()
            before = db_path.read_bytes()

            result = runner.invoke(
                checkpoint,
                [
                    "restore",
                    "--input",
                    str(valid_checkpoint_file),
                    "--agent",
                    "test_agent",
                    "--dry-run",
                    "--json",
                ],
            )
            assert result.exit_code == 0, result.output
            json_str = result.output[result.output.index("{") :]
            payload = json.loads(json_str)
            assert payload["dry_run"] is True
            assert payload["committed"] is False
            assert "state_diff" in payload
            assert payload["state_diff"]["would_commit"] is True
            assert db_path.read_bytes() == before
