"""Focused coverage for durable effect replay audit trail (issue #541)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from click.testing import CliRunner

from talos_agent.cli import main
from talos_agent.db import LocalDB
from talos_agent.job_effects import (
    JobEffectDispatcher,
    JobEffectStore,
    JobValidationError,
    ReplayAuditAction,
)

OWNER = "talos-provider"


def _job(job_id: str = "job-1") -> dict:
    return {
        "id": job_id,
        "talosId": OWNER,
        "requesterTalosId": "talos-requester",
        "serviceName": "research",
        "payload": {"query": "safe"},
    }


def _store(db: LocalDB) -> JobEffectStore:
    return JobEffectStore(db, owner_talos_id=OWNER)


def _prepare(store: JobEffectStore, *, job_id: str = "job-1", result: dict | None = None) -> str:
    store.ingest(_job(job_id))
    store.mark_claimed(
        job_id,
        fencing_token=7,
        lease_expires_at="2026-07-25T12:00:00+00:00",
    )
    return store.prepare_effect(job_id, result or {"answer": "done"})


def test_prepare_records_effect_prepared_audit(tmp_path: Path):
    db = LocalDB(path=tmp_path / "prepare.db")
    store = _store(db)
    effect_id = _prepare(store)

    trail = store.audit_trail(effect_id=effect_id)
    assert len(trail) == 1
    row = trail[0]
    assert row["action"] == ReplayAuditAction.EFFECT_PREPARED.value
    assert row["to_state"] == "pending"
    assert row["attempt_count"] == 0
    assert row["actor"] == "system:prepare"
    assert "result" not in row
    assert "payload" not in row
    db.close()


def test_dispatch_failure_and_operator_requeue_append_audit(tmp_path: Path):
    db = LocalDB(path=tmp_path / "requeue-audit.db")
    store = _store(db)
    effect_id = _prepare(store, result={"answer": "secret-value"})

    effect = store.claim_due("worker-one")[0]
    store.mark_failure(effect, error_code="transport_error", indeterminate=True)
    store.requeue(effect_id, expected_attempt=1)

    actions = [row["action"] for row in store.audit_trail(effect_id=effect_id)]
    assert actions == [
        ReplayAuditAction.EFFECT_PREPARED.value,
        ReplayAuditAction.DISPATCH_CLAIMED.value,
        ReplayAuditAction.DISPATCH_FAILED.value,
        ReplayAuditAction.OPERATOR_REQUEUED.value,
    ]
    failed = store.audit_trail(effect_id=effect_id)[2]
    assert failed["error_code"] == "transport_error"
    assert failed["to_state"] == "indeterminate"
    requeued = store.audit_trail(effect_id=effect_id)[3]
    assert requeued["from_state"] == "indeterminate"
    assert requeued["to_state"] == "pending"
    assert requeued["actor"] == "operator:requeue"

    rendered = json.dumps(store.audit_trail(effect_id=effect_id))
    assert "secret-value" not in rendered
    assert "result_json" not in rendered
    db.close()


@pytest.mark.asyncio
async def test_successful_dispatch_records_succeeded_audit(tmp_path: Path):
    db = LocalDB(path=tmp_path / "success-audit.db")
    store = _store(db)
    effect_id = _prepare(store)

    api = AsyncMock()
    api.get_job_result.return_value = {"status": "pending"}
    api.submit_job_result.return_value = {"ok": True}
    await JobEffectDispatcher(store, api, worker_id="worker-ok").dispatch_once()

    actions = [row["action"] for row in store.audit_trail(effect_id=effect_id)]
    assert ReplayAuditAction.DISPATCH_CLAIMED.value in actions
    assert ReplayAuditAction.DISPATCH_SUCCEEDED.value in actions
    db.close()


@pytest.mark.asyncio
async def test_reconciled_dispatch_records_reconciled_audit(tmp_path: Path):
    db = LocalDB(path=tmp_path / "reconcile-audit.db")
    store = _store(db)
    result = {"answer": "done"}
    effect_id = _prepare(store, result=result)

    api = AsyncMock()
    api.get_job_result.return_value = {"status": "completed", "result": result}
    await JobEffectDispatcher(store, api, worker_id="worker-rec").dispatch_once()

    actions = [row["action"] for row in store.audit_trail(effect_id=effect_id)]
    assert ReplayAuditAction.DISPATCH_RECONCILED.value in actions
    assert ReplayAuditAction.DISPATCH_SUCCEEDED.value not in actions
    db.close()


def test_audit_trail_rejects_missing_filter_and_bad_limit(tmp_path: Path):
    db = LocalDB(path=tmp_path / "validate.db")
    store = _store(db)
    with pytest.raises(JobValidationError):
        store.audit_trail()
    with pytest.raises(JobValidationError):
        store.audit_trail(effect_id="effect-1", limit=0)
    with pytest.raises(JobValidationError):
        store.audit_trail(effect_id="effect-1", limit=201)
    db.close()


def test_audit_cli_never_prints_payload_or_result(tmp_path: Path):
    secret = "private-user-content"
    path = tmp_path / "cli-audit.db"
    db = LocalDB(path=path)
    store = _store(db)
    effect_id = _prepare(store, result={"answer": secret})
    effect = store.claim_due("worker-cli")[0]
    store.mark_failure(effect, error_code="transport_error", indeterminate=True)
    db.close()

    result = CliRunner().invoke(
        main,
        [
            "jobs",
            "audit",
            "--db-path",
            str(path),
            "--talos-id",
            OWNER,
            "--effect-id",
            effect_id,
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert effect_id in result.output
    assert "dispatch_failed" in result.output
    assert secret not in result.output
    assert "result_json" not in result.output
