"""Tests for transactional staged checkpoint restore (#295).

Covers:
- Preflight validation & error paths (active state untouched).
- Staging & database migrations against staged state only.
- Structural & data invariant verification.
- Atomic commit & bounded backup/rollback.
- Restart-safe recovery of interrupted restores.
- CLI `checkpoint restore` exit codes & output formatting.
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
    InvariantError,
    PreflightError,
    RollbackError,
    StagedRestoreConfig,
    StagedRestoreManager,
    perform_staged_restore,
    recover_interrupted_restore,
)


@pytest.fixture
def target_db(tmp_path: Path) -> Path:
    db_file = tmp_path / "agent-test_agent.db"
    db = LocalDB(path=db_file)
    db._conn.execute(
        "INSERT INTO schedules (task_name, last_run_at) VALUES ('active_task', '2026-01-01T00:00:00Z')"
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
        "tables": {"schedules": 2, "activity_log": 5},
        "tables_data": {
            "schedules": [
                {"task_name": "task1", "last_run_at": "2026-07-20T10:00:00Z"},
                {"task_name": "task2", "last_run_at": "2026-07-21T12:00:00Z"},
            ]
        },
    }
    cp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return cp_path


class TestPreflightValidation:
    @pytest.mark.asyncio
    async def test_non_existent_file_raises_preflight(self, target_db: Path):
        cfg = StagedRestoreConfig(require_agent_match=True)
        with pytest.raises(PreflightError, match="Checkpoint file not found"):
            await perform_staged_restore(
                target_db_path=target_db,
                checkpoint_input=target_db.parent / "non_existent.json",
                agent_id="test_agent",
                config=cfg,
            )

    @pytest.mark.asyncio
    async def test_file_size_exceeded_raises_preflight(self, target_db: Path, valid_checkpoint_file: Path):
        cfg = StagedRestoreConfig(max_size_bytes=10)  # tiny limit
        with pytest.raises(PreflightError, match="exceeds limit"):
            await perform_staged_restore(
                target_db_path=target_db,
                checkpoint_input=valid_checkpoint_file,
                agent_id="test_agent",
                config=cfg,
            )

    @pytest.mark.asyncio
    async def test_invalid_json_raises_preflight(self, target_db: Path, tmp_path: Path):
        bad_json = tmp_path / "bad.json"
        bad_json.write_text("not json content", encoding="utf-8")

        with pytest.raises(PreflightError, match="Failed to parse checkpoint JSON"):
            await perform_staged_restore(
                target_db_path=target_db,
                checkpoint_input=bad_json,
                agent_id="test_agent",
            )

    @pytest.mark.asyncio
    async def test_unsupported_schema_version_raises_preflight(self, target_db: Path, tmp_path: Path):
        bad_schema = tmp_path / "bad_schema.json"
        bad_schema.write_text(json.dumps({"schema_version": 99, "agent_id": "test_agent"}), encoding="utf-8")

        with pytest.raises(PreflightError, match="Unsupported checkpoint schema version"):
            await perform_staged_restore(
                target_db_path=target_db,
                checkpoint_input=bad_schema,
                agent_id="test_agent",
            )

    @pytest.mark.asyncio
    async def test_agent_id_mismatch_raises_preflight(self, target_db: Path, valid_checkpoint_file: Path):
        cfg = StagedRestoreConfig(require_agent_match=True)
        with pytest.raises(PreflightError, match="does not match expected"):
            await perform_staged_restore(
                target_db_path=target_db,
                checkpoint_input=valid_checkpoint_file,
                agent_id="different_agent",
                config=cfg,
            )


class TestStagingAndInvariants:
    @pytest.mark.asyncio
    async def test_successful_staged_restore(self, target_db: Path, valid_checkpoint_file: Path):
        res = await perform_staged_restore(
            target_db_path=target_db,
            checkpoint_input=valid_checkpoint_file,
            agent_id="test_agent",
        )

        assert res.preflight_passed is True
        assert res.invariants_passed is True
        assert res.committed is True
        assert res.rolled_back is False

        conn = sqlite3.connect(str(target_db))
        rows = conn.execute("SELECT task_name FROM schedules ORDER BY task_name").fetchall()
        conn.close()
        assert [r[0] for r in rows] == ["task1", "task2"]

    @pytest.mark.asyncio
    async def test_invariant_verification_failure_cancels_commit(self, target_db: Path, tmp_path: Path):
        corrupt_cp = tmp_path / "corrupt.json"
        corrupt_cp.write_text(
            json.dumps({"schema_version": 1, "agent_id": "test_agent", "tables": {}}),
            encoding="utf-8",
        )

        mgr = StagedRestoreManager()
        with patch.object(mgr, "_verify_invariants", side_effect=InvariantError("Mock invariant error")):
            with pytest.raises(InvariantError, match="Mock invariant error"):
                await mgr.perform_staged_restore(
                    target_db_path=target_db,
                    checkpoint_input=corrupt_cp,
                    agent_id="test_agent",
                )

        # Ensure active database remains untouched
        conn = sqlite3.connect(str(target_db))
        rows = conn.execute("SELECT task_name FROM schedules").fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0][0] == "active_task"


class TestAtomicCommitAndRollback:
    @pytest.mark.asyncio
    async def test_rollback_on_commit_failure(self, target_db: Path, valid_checkpoint_file: Path):
        mgr = StagedRestoreManager()

        with patch("talos_agent.restore.reconcile_after_restore", side_effect=RuntimeError("Reconciliation crash")):
            with pytest.raises(RollbackError, match="Restore commit failed"):
                await mgr.perform_staged_restore(
                    target_db_path=target_db,
                    checkpoint_input=valid_checkpoint_file,
                    agent_id="test_agent",
                )

        # Active database state should have rolled back to active_task
        conn = sqlite3.connect(str(target_db))
        rows = conn.execute("SELECT task_name FROM schedules").fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0][0] == "active_task"

    def test_recover_interrupted_restore(self, target_db: Path, tmp_path: Path):
        backup_path = tmp_path / f"{target_db.name}.backup.12345"
        backup_path.write_bytes(target_db.read_bytes())

        journal_path = tmp_path / f"{target_db.name}.restore_journal.json"
        journal_payload = {
            "status": "committing",
            "agent_id": "test_agent",
            "staged_path": str(tmp_path / "staged.db"),
            "target_path": str(target_db),
            "backup_path": str(backup_path),
        }
        journal_path.write_text(json.dumps(journal_payload), encoding="utf-8")

        recovered = recover_interrupted_restore(target_db)
        assert recovered is True
        assert journal_path.exists() is False


class TestCheckpointCLIRestore:
    def test_cli_restore_success(self, tmp_path: Path, valid_checkpoint_file: Path):
        runner = CliRunner()

        with patch("talos_agent.db.APP_DIR", tmp_path):
            result = runner.invoke(
                checkpoint,
                ["restore", "--input", str(valid_checkpoint_file), "--agent", "test_agent", "--json"],
            )
            assert result.exit_code == 0
            json_str = result.output[result.output.index("{") :]
            res_dict = json.loads(json_str)
            assert res_dict["agent_id"] == "test_agent"
            assert res_dict["committed"] is True

    def test_cli_restore_validation_error(self, valid_checkpoint_file: Path):
        runner = CliRunner()
        result = runner.invoke(
            checkpoint,
            ["restore", "--input", str(valid_checkpoint_file), "--agent", "wrong_agent"],
        )
        assert result.exit_code == CheckpointExitCode.VALIDATION_ERROR
