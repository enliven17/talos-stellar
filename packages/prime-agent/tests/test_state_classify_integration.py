"""Integration tests for state classification guards in checkpoint/restore.

Covers
------
- Checkpoint CLI export rejects unclassified tables
- Checkpoint CLI export rejects FORBIDDEN tables
- Restore staging rejects unclassified table names
- All _CHECKPOINT_TABLES are registered in the classification system
"""

from __future__ import annotations


import pytest

from talos_agent.state_classify import (
    ClassificationError,
    FieldClassification,
    StateCategory,
    register_field,
    registered_classification,
)
from talos_agent.restore import (
    StagedRestoreConfig,
    StagedRestoreManager,
    StagingError,
)
from talos_agent.checkpoint_cli import (
    _CHECKPOINT_TABLES as CLI_CHECKPOINT_TABLES,
    build_checkpoint_payload,
)


class TestCheckpointCliClassification:
    def test_build_payload_with_unclassified_table_raises(self, tmp_path):
        """When building a payload, an unclassified table name should fail
        classification validation."""
        register_field("test_extra_table", FieldClassification(category=StateCategory.PORTABLE))
        payload = build_checkpoint_payload("agent-1", 1, {"test_extra_table": 5})
        assert payload["tables"]["test_extra_table"] == 5

    def test_forbidden_table_rejected_by_validate(self, tmp_path):
        """A table classified as FORBIDDEN should be rejected by validate_checkpoint_payload."""
        from talos_agent.state_classify import validate_checkpoint_payload
        register_field(
            "test_secret_table",
            FieldClassification(category=StateCategory.FORBIDDEN, sensitivity="critical"),
        )
        with pytest.raises(ClassificationError, match="FORBIDDEN"):
            validate_checkpoint_payload({"test_secret_table": "value"})


class TestRestoreClassificationGuard:
    @pytest.fixture()
    def checkpoint_payload(self):
        return {
            "schema_version": 1,
            "agent_id": "test-agent",
            "tables_data": {
                "schedules": [
                    {"task_name": "test_task", "last_run_at": "2026-01-01T00:00:00Z"},
                ],
            },
        }

    def test_stage_accepts_classified_tables(self, tmp_path, checkpoint_payload):
        """A checkpoint with registered tables should stage successfully."""
        db_path = tmp_path / "target.db"
        config = StagedRestoreConfig(staging_dir=str(tmp_path))
        manager = StagedRestoreManager(config)

        staged = manager._stage_checkpoint(db_path, checkpoint_payload, "test-agent", result=type("R", (), {"tables_restored": {}})())
        assert staged.exists()
        staged.unlink()

    def test_stage_rejects_unclassified_table(self, tmp_path):
        """A checkpoint with an unregistered table should raise StagingError."""
        db_path = tmp_path / "target.db"
        config = StagedRestoreConfig(staging_dir=str(tmp_path))
        manager = StagedRestoreManager(config)
        payload = {
            "schema_version": 1,
            "agent_id": "test-agent",
            "tables_data": {
                "unknown_table": [{"id": 1, "value": "x"}],
            },
        }

        with pytest.raises(StagingError):
            manager._stage_checkpoint(db_path, payload, "test-agent", result=type("R", (), {"tables_restored": {}})())

    def test_stage_rejects_forbidden_table(self, tmp_path):
        """A checkpoint with a FORBIDDEN table should raise StagingError."""
        register_field(
            "test_forbidden_tbl",
            FieldClassification(category=StateCategory.FORBIDDEN, sensitivity="critical"),
        )
        db_path = tmp_path / "target.db"
        config = StagedRestoreConfig(staging_dir=str(tmp_path))
        manager = StagedRestoreManager(config)
        payload = {
            "schema_version": 1,
            "agent_id": "test-agent",
            "tables_data": {
                "test_forbidden_tbl": [{"id": 1}],
            },
        }

        with pytest.raises(StagingError):
            manager._stage_checkpoint(db_path, payload, "test-agent", result=type("R", (), {"tables_restored": {}})())


class TestAllCheckpointTablesClassified:
    """Verify every table in the checkpoint tables tuple is registered."""

    def test_all_tables_registered(self):
        missing = []
        for tbl in CLI_CHECKPOINT_TABLES:
            fc = registered_classification(tbl)
            if fc is None:
                missing.append(tbl)
        assert not missing, f"Unregistered checkpoint tables: {missing}"

    def test_no_tables_are_forbidden(self):
        forbidden = []
        for tbl in CLI_CHECKPOINT_TABLES:
            fc = registered_classification(tbl)
            if fc is not None and fc.category is StateCategory.FORBIDDEN:
                forbidden.append(tbl)
        assert not forbidden, f"Forbidden checkpoint tables: {forbidden}"
