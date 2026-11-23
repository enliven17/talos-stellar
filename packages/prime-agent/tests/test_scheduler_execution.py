"""Tests for durable scheduler execution identities."""

from __future__ import annotations

from pathlib import Path

from talos_agent.db import LocalDB


def test_execution_identity_survives_restart_and_blocks_uncertain_retry(
    tmp_path: Path,
) -> None:
    db = LocalDB(path=tmp_path / "scheduler.db")
    first = db.reserve_task_execution("dividend_distribution")
    assert first is not None
    assert db.get_task_execution(first["execution_id"])["status"] == "reserved"
    db.close()

    restarted = LocalDB(path=tmp_path / "scheduler.db")
    assert restarted.reserve_task_execution("dividend_distribution") is None
    assert restarted.get_task_execution(first["execution_id"])["status"] == "uncertain"
    restarted.close()


def test_retryable_execution_gets_a_new_identity(tmp_path: Path) -> None:
    db = LocalDB(path=tmp_path / "scheduler.db")
    first = db.reserve_task_execution("loan_repayment")
    assert first is not None
    db.finish_task_execution(first["execution_id"], "retryable")

    second = db.reserve_task_execution("loan_repayment")
    assert second is not None
    assert second["execution_id"] != first["execution_id"]
    db.finish_task_execution(second["execution_id"], "succeeded")
    db.close()


def test_reconciled_uncertain_execution_can_be_resolved(tmp_path: Path) -> None:
    db = LocalDB(path=tmp_path / "scheduler.db")
    execution = db.reserve_task_execution("agent_cycle")
    assert execution is not None
    db.close()

    restarted = LocalDB(path=tmp_path / "scheduler.db")
    assert restarted.reserve_task_execution("agent_cycle") is None
    restarted.resolve_task_execution(execution["execution_id"], "succeeded")
    assert restarted.get_task_execution(execution["execution_id"])["status"] == "succeeded"
    assert restarted.reserve_task_execution("agent_cycle") is not None
    restarted.close()
