"""Security and recovery tests for the durable provider-job effect boundary."""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from click.testing import CliRunner
from pydantic import ValidationError

import talos_agent.db as db_module
from talos_agent.api_client import TalosAPIClient
from talos_agent.cli import main
from talos_agent.config import Settings
from talos_agent.db import LocalDB, _MIGRATIONS
from talos_agent.job_effects import (
    JobAuthorizationError,
    JobBusyError,
    JobCapacityError,
    JobConflictError,
    JobEffectDispatcher,
    JobEffectLimits,
    JobEffectStore,
    JobStateError,
    JobValidationError,
)

OWNER = "talos-provider"


def _job(
    job_id: str = "job-1",
    *,
    payload: object | None = None,
    owner: str = OWNER,
) -> dict:
    return {
        "id": job_id,
        "talosId": owner,
        "requesterTalosId": "talos-requester",
        "serviceName": "research",
        "payload": {"query": "safe"} if payload is None else payload,
    }


def _store(
    db: LocalDB,
    *,
    limits: JobEffectLimits | None = None,
    owner: str = OWNER,
) -> JobEffectStore:
    return JobEffectStore(db, owner_talos_id=owner, limits=limits)


def _prepare(
    store: JobEffectStore,
    *,
    job_id: str = "job-1",
    result: dict | None = None,
) -> str:
    store.ingest(_job(job_id))
    store.mark_claimed(
        job_id,
        fencing_token=7,
        lease_expires_at="2026-07-25T12:00:00+00:00",
    )
    return store.prepare_effect(job_id, result or {"answer": "done"})


def test_migration_7_creates_durable_job_tables(tmp_path: Path):
    db = LocalDB(path=tmp_path / "migration.db")
    tables = {
        row[0]
        for row in db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    version = db._conn.execute("PRAGMA user_version").fetchone()[0]

    assert {"job_inbox", "job_effect_outbox"}.issubset(tables)
    assert version == _MIGRATIONS[-1][0] == 7
    db.close()


def test_store_enables_crash_safe_sqlite_settings(tmp_path: Path):
    db = LocalDB(path=tmp_path / "sqlite-settings.db")
    _store(db)
    assert db._conn.execute("PRAGMA synchronous").fetchone()[0] == 2
    assert db._conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    db.close()


def test_migration_7_upgrades_v6_without_losing_existing_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    path = tmp_path / "upgrade-v6.db"
    original = list(db_module._MIGRATIONS)
    monkeypatch.setattr(db_module, "_MIGRATIONS", original[:-1])
    old = LocalDB(path=path)
    old.add_activity("existing", "keep-me", "test")
    old.close()

    monkeypatch.setattr(db_module, "_MIGRATIONS", original)
    upgraded = LocalDB(path=path)

    assert upgraded._conn.execute("PRAGMA user_version").fetchone()[0] == 7
    assert (
        upgraded._conn.execute(
            "SELECT content FROM activity_log WHERE type = 'existing'"
        ).fetchone()["content"]
        == "keep-me"
    )
    assert (
        upgraded._conn.execute(
            "SELECT name FROM sqlite_master WHERE name = 'job_effect_outbox'"
        ).fetchone()
        is not None
    )
    upgraded.close()


def test_rollout_is_disabled_by_default_and_configuration_is_bounded(
    monkeypatch: pytest.MonkeyPatch,
):
    settings = Settings(
        _env_file=None,
        talos_api_key="test",
        groq_api_key="test",
    )
    assert settings.talos_durable_job_effects_enabled is False

    with pytest.raises(ValidationError):
        Settings(_env_file=None, talos_job_effect_batch_size=201)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, talos_job_effect_max_result_bytes=2_097_153)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, job_lease_ttl=601)
    monkeypatch.setenv("TALOS_DURABLE_JOB_EFFECTS_ENABLED", "true")
    monkeypatch.setenv("TALOS_JOB_EFFECT_BATCH_SIZE", "7")
    enabled = Settings(_env_file=None)
    assert enabled.talos_durable_job_effects_enabled is True
    assert enabled.talos_job_effect_batch_size == 7


def test_duplicate_inbox_delivery_is_idempotent_and_conflicts_are_rejected(
    tmp_path: Path,
):
    db = LocalDB(path=tmp_path / "inbox.db")
    store = _store(db)

    first = store.ingest(_job())
    duplicate = store.ingest(_job())

    assert duplicate == first
    assert (
        db._conn.execute("SELECT COUNT(*) FROM job_inbox").fetchone()[0] == 1
    )
    assert (
        db._conn.execute("SELECT COUNT(*) FROM commerce_queue").fetchone()[0]
        == 1
    )
    with pytest.raises(JobConflictError):
        store.ingest(_job(payload={"query": "different"}))
    changed_service = _job()
    changed_service["serviceName"] = "different-service"
    with pytest.raises(JobConflictError):
        store.ingest(changed_service)
    db.close()


def test_authorization_identifiers_and_payload_limits_are_enforced(tmp_path: Path):
    db = LocalDB(path=tmp_path / "validation.db")
    store = _store(
        db,
        limits=JobEffectLimits(max_payload_bytes=20, max_result_bytes=20),
    )

    with pytest.raises(JobAuthorizationError):
        store.ingest(_job(owner="other-talos"))
    with pytest.raises(JobValidationError):
        store.ingest(_job("../escape"))
    with pytest.raises(JobValidationError):
        store.ingest(_job(payload={"content": "x" * 50}))
    unsafe_service = _job()
    unsafe_service["serviceName"] = "unsafe\nservice"
    with pytest.raises(JobValidationError):
        store.ingest(unsafe_service)

    store.ingest(_job(payload={}))
    store.mark_claimed(
        "job-1",
        fencing_token=1,
        lease_expires_at="2026-07-25T12:00:00+00:00",
    )
    with pytest.raises(JobValidationError):
        store.prepare_effect("job-1", {"result": "x" * 50})
    assert (
        db._conn.execute("SELECT COUNT(*) FROM job_effect_outbox").fetchone()[0]
        == 0
    )
    db.close()


def test_inbox_capacity_is_bounded(tmp_path: Path):
    db = LocalDB(path=tmp_path / "capacity.db")
    store = _store(db, limits=JobEffectLimits(max_inbox_records=1))

    store.ingest(_job("job-1"))
    with pytest.raises(JobCapacityError):
        store.ingest(_job("job-2"))
    db.close()


def test_stale_fencing_token_and_unclaimed_fulfillment_are_rejected(tmp_path: Path):
    db = LocalDB(path=tmp_path / "fencing.db")
    store = _store(db)
    store.ingest(_job())

    with pytest.raises(JobStateError):
        store.prepare_effect("job-1", {"answer": "no-claim"})

    store.mark_claimed(
        "job-1",
        fencing_token=9,
        lease_expires_at="2026-07-25T12:00:00+00:00",
    )
    with pytest.raises(JobConflictError):
        store.mark_claimed(
            "job-1",
            fencing_token=8,
            lease_expires_at="2026-07-25T12:00:00+00:00",
        )
    db.close()


def test_effect_preparation_is_atomic_idempotent_and_rejects_result_reuse(
    tmp_path: Path,
):
    db = LocalDB(path=tmp_path / "effect.db")
    store = _store(db)
    effect_id = _prepare(store)

    assert store.prepare_effect("job-1", {"answer": "done"}) == effect_id
    assert (
        db._conn.execute("SELECT COUNT(*) FROM job_effect_outbox").fetchone()[0]
        == 1
    )
    inbox = db._conn.execute(
        "SELECT state FROM job_inbox WHERE job_id = 'job-1'"
    ).fetchone()
    assert inbox["state"] == "effect_pending"
    with pytest.raises(JobConflictError):
        store.prepare_effect("job-1", {"answer": "changed"})
    db.close()


def test_outbox_capacity_failure_rolls_back_inbox_transition(tmp_path: Path):
    db = LocalDB(path=tmp_path / "outbox-capacity.db")
    store = _store(db, limits=JobEffectLimits(max_outbox_records=1))
    _prepare(store, job_id="job-1")
    store.ingest(_job("job-2"))
    store.mark_claimed(
        "job-2",
        fencing_token=2,
        lease_expires_at="2026-07-25T12:00:00+00:00",
    )

    with pytest.raises(JobCapacityError):
        store.prepare_effect("job-2", {"answer": "second"})

    assert (
        db._conn.execute(
            "SELECT state FROM job_inbox WHERE job_id = 'job-2'"
        ).fetchone()["state"]
        == "claimed"
    )
    assert (
        db._conn.execute("SELECT COUNT(*) FROM job_effect_outbox").fetchone()[0]
        == 1
    )
    db.close()


def test_cross_instance_dispatch_lease_allows_one_owner(tmp_path: Path):
    path = tmp_path / "lease.db"
    db_one = LocalDB(path=path)
    db_two = LocalDB(path=path)
    first = _store(db_one)
    second = _store(db_two)
    _prepare(first)

    claimed_one = first.claim_due("worker-one")
    claimed_two = second.claim_due("worker-two")

    assert len(claimed_one) == 1
    assert claimed_two == []
    db_one.close()
    db_two.close()


def test_sqlite_lock_wait_is_bounded(tmp_path: Path):
    path = tmp_path / "locked.db"
    holder_db = LocalDB(path=path)
    contender_db = LocalDB(path=path)
    contender = _store(
        contender_db,
        limits=JobEffectLimits(busy_timeout_ms=10),
    )
    holder_db._conn.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(JobBusyError):
            contender.ingest(_job())
    finally:
        holder_db._conn.rollback()
        holder_db.close()
        contender_db.close()


def test_concurrent_duplicate_delivery_across_connections_is_deterministic(
    tmp_path: Path,
):
    path = tmp_path / "concurrent.db"
    LocalDB(path=path).close()

    def ingest_once() -> str:
        db = LocalDB(path=path)
        try:
            return _store(db).ingest(_job()).payload_digest
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        digests = list(pool.map(lambda _: ingest_once(), range(2)))

    db = LocalDB(path=path)
    assert len(set(digests)) == 1
    assert db._conn.execute("SELECT COUNT(*) FROM job_inbox").fetchone()[0] == 1
    db.close()


@pytest.mark.asyncio
async def test_successful_dispatch_atomically_completes_inbox_and_outbox(
    tmp_path: Path,
):
    db = LocalDB(path=tmp_path / "success.db")
    store = _store(db)
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(return_value={"status": "pending"})
    api.submit_job_result = AsyncMock(return_value={"status": "completed"})

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["succeeded"] == 1
    assert store.effect_status(effect_id)["state"] == "succeeded"
    assert (
        db._conn.execute(
            "SELECT state FROM job_inbox WHERE job_id = 'job-1'"
        ).fetchone()["state"]
        == "completed"
    )
    api.submit_job_result.assert_awaited_once_with(
        "job-1",
        {"answer": "done"},
        fencing_token=7,
        idempotency_key=effect_id,
    )
    db.close()


@pytest.mark.asyncio
async def test_lost_response_is_reconciled_without_duplicate_visible_effect(
    tmp_path: Path,
):
    db = LocalDB(path=tmp_path / "lost-response.db")
    store = _store(db)
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(
        side_effect=[
            {"status": "pending"},
            {"status": "completed", "result": {"answer": "done"}},
        ]
    )
    api.submit_job_result = AsyncMock(side_effect=TimeoutError)

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["succeeded"] == 1
    assert store.effect_status(effect_id)["state"] == "succeeded"
    assert api.submit_job_result.await_count == 1
    db.close()


@pytest.mark.asyncio
async def test_restart_recovers_expired_dispatch_lease_by_remote_reconciliation(
    tmp_path: Path,
):
    path = tmp_path / "restart.db"
    first_db = LocalDB(path=path)
    first_store = _store(first_db)
    effect_id = _prepare(first_store)
    assert first_store.claim_due("crashed-worker")
    first_db._conn.execute(
        """
        UPDATE job_effect_outbox
        SET lease_until = ?
        WHERE effect_id = ?
        """,
        (
            (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(),
            effect_id,
        ),
    )
    first_db._conn.commit()
    first_db.close()

    restarted_db = LocalDB(path=path)
    restarted_store = _store(restarted_db)
    api = MagicMock()
    api.get_job_result = AsyncMock(
        return_value={"status": "completed", "result": {"answer": "done"}}
    )
    api.submit_job_result = AsyncMock()

    counts = await JobEffectDispatcher(
        restarted_store, api, worker_id="restart-worker"
    ).dispatch_once()

    assert counts["succeeded"] == 1
    assert restarted_store.effect_status(effect_id)["attempt_count"] == 2
    api.submit_job_result.assert_not_awaited()
    restarted_db.close()


@pytest.mark.asyncio
async def test_remote_result_conflict_is_terminal_and_not_overwritten(tmp_path: Path):
    db = LocalDB(path=tmp_path / "conflict.db")
    store = _store(db)
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(
        return_value={"status": "completed", "result": {"answer": "other"}}
    )
    api.submit_job_result = AsyncMock()

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["conflict"] == 1
    assert store.effect_status(effect_id)["state"] == "conflict"
    api.submit_job_result.assert_not_awaited()
    db.close()


@pytest.mark.asyncio
async def test_malformed_completed_remote_result_is_a_safe_conflict(tmp_path: Path):
    db = LocalDB(path=tmp_path / "malformed-remote.db")
    store = _store(db)
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(
        return_value={"status": "completed", "result": "unexpected"}
    )
    api.submit_job_result = AsyncMock()

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["conflict"] == 1
    assert store.effect_status(effect_id)["state"] == "conflict"
    api.submit_job_result.assert_not_awaited()
    db.close()


@pytest.mark.asyncio
async def test_retryable_failure_becomes_dead_at_attempt_bound(tmp_path: Path):
    db = LocalDB(path=tmp_path / "dead.db")
    store = _store(
        db,
        limits=JobEffectLimits(max_attempts=1, retry_base_seconds=1),
    )
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(return_value={"status": "pending"})
    api.submit_job_result = AsyncMock(return_value=None)

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["dead"] == 1
    status = store.effect_status(effect_id)
    assert status["state"] == "dead"
    assert status["last_error_code"] == "remote_rejected_or_pending"
    assert store.claimed_jobs() == {}
    db.close()


@pytest.mark.asyncio
async def test_stale_remote_lease_is_refreshed_for_next_attempt(tmp_path: Path):
    db = LocalDB(path=tmp_path / "refresh-claim.db")
    store = _store(db, limits=JobEffectLimits(retry_base_seconds=1))
    effect_id = _prepare(store)
    api = MagicMock()
    api.get_job_result = AsyncMock(return_value={"status": "pending"})
    api.submit_job_result = AsyncMock(return_value=None)
    api.claim_job = AsyncMock(
        return_value={
            "fencingToken": 8,
            "leaseExpiresAt": "2026-07-25T12:05:00+00:00",
        }
    )

    counts = await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    assert counts["retryable"] == 1
    assert store.effect_status(effect_id)["last_error_code"] == "remote_claim_refreshed"
    token = db._conn.execute(
        "SELECT fencing_token FROM job_effect_outbox WHERE effect_id = ?",
        (effect_id,),
    ).fetchone()["fencing_token"]
    assert token == 8
    db.close()


@pytest.mark.asyncio
async def test_failure_logs_are_structured_and_redacted(tmp_path: Path):
    secret = "user-payload-secret"
    db = LocalDB(path=tmp_path / "redaction.db")
    store = _store(db)
    _prepare(store, result={"answer": secret})
    api = MagicMock()
    api.get_job_result = AsyncMock(return_value={"status": "pending"})
    api.submit_job_result = AsyncMock(side_effect=RuntimeError(secret))
    fake_log = MagicMock()

    with patch("talos_agent.job_effects.log", fake_log):
        await JobEffectDispatcher(store, api, worker_id="worker-one").dispatch_once()

    rendered = repr(fake_log.mock_calls)
    assert secret not in rendered
    assert "transport_error" in rendered
    db.close()


def test_inspection_and_cli_never_return_payload_or_result(tmp_path: Path):
    secret = "private-user-content"
    path = tmp_path / "inspect.db"
    db = LocalDB(path=path)
    store = _store(db)
    effect_id = _prepare(
        store,
        result={"answer": secret},
    )
    metadata = store.inspect()
    assert secret not in json.dumps(metadata)
    assert "result_json" not in metadata[0]
    db.close()

    result = CliRunner().invoke(
        main,
        [
            "jobs",
            "inspect",
            "--db-path",
            str(path),
            "--talos-id",
            OWNER,
            "--json",
        ],
    )
    assert result.exit_code == 0, result.output
    assert effect_id in result.output
    assert secret not in result.output
    assert "result_json" not in result.output


def test_operator_requeue_is_idempotent_and_rejects_stale_decisions(tmp_path: Path):
    db = LocalDB(path=tmp_path / "requeue.db")
    store = _store(db)
    effect_id = _prepare(store)
    effect = store.claim_due("worker-one")[0]
    store.mark_failure(effect, error_code="transport_error", indeterminate=True)

    first = store.requeue(effect_id, expected_attempt=1)
    duplicate = store.requeue(effect_id, expected_attempt=1)
    assert first == duplicate
    assert store.claimed_jobs() == {"job-1": 7}
    with pytest.raises(JobConflictError):
        store.requeue(effect_id, expected_attempt=0)
    db.close()


@pytest.mark.asyncio
async def test_real_commerce_tool_boundary_survives_duplicate_fulfillment(
    tmp_path: Path,
):
    from talos_agent.tools.commerce import claim_job, fulfill_job, get_pending_jobs

    db = LocalDB(path=tmp_path / "boundary.db")
    store = _store(db)
    api = MagicMock()
    api.get_pending_jobs = AsyncMock(return_value=[_job()])
    api.claim_job = AsyncMock(
        return_value={
            "fencingToken": 3,
            "leaseExpiresAt": "2026-07-25T12:00:00+00:00",
        }
    )
    api.get_job_result = AsyncMock(return_value={"status": "pending"})
    api.submit_job_result = AsyncMock(return_value={"status": "completed"})
    dispatcher = JobEffectDispatcher(store, api, worker_id="boundary-worker")

    with (
        patch("talos_agent.tools.commerce._api", api),
        patch("talos_agent.tools.commerce._db", db),
        patch("talos_agent.tools.commerce._job_effect_store", store),
        patch(
            "talos_agent.tools.commerce._job_effect_dispatcher",
            dispatcher,
        ),
    ):
        pending = await get_pending_jobs()
        invalid_claim = await claim_job("job-1", ttl_seconds=601)
        claimed = await claim_job("job-1")
        first = await fulfill_job("job-1", '{"answer":"done"}')
        duplicate = await fulfill_job("job-1", '{"answer":"done"}')

    assert pending["count"] == 1
    assert invalid_claim == {"error": "validation_error"}
    assert claimed["fencing_token"] == 3
    api.claim_job.assert_awaited_once()
    assert first["status"] == "fulfilled"
    assert duplicate["status"] == "fulfilled"
    assert api.submit_job_result.await_count == 1
    db.close()


@pytest.mark.asyncio
async def test_legacy_fulfillment_path_remains_backward_compatible(tmp_path: Path):
    from talos_agent.tools.commerce import fulfill_job

    db = LocalDB(path=tmp_path / "legacy.db")
    api = MagicMock()
    api.submit_job_result = AsyncMock(return_value={"status": "completed"})

    with (
        patch("talos_agent.tools.commerce._api", api),
        patch("talos_agent.tools.commerce._db", db),
        patch("talos_agent.tools.commerce._job_effect_store", None),
        patch("talos_agent.tools.commerce._job_effect_dispatcher", None),
        patch("talos_agent.tools.commerce._claimed_jobs", {"job-1": 4}),
    ):
        result = await fulfill_job("job-1", '{"answer":"legacy"}')

    assert result == {"status": "fulfilled", "job_id": "job-1"}
    api.submit_job_result.assert_awaited_once_with(
        "job-1", {"answer": "legacy"}, fencing_token=4
    )
    db.close()


@pytest.mark.asyncio
async def test_api_client_forwards_stable_idempotency_key():
    client = object.__new__(TalosAPIClient)
    client._post = AsyncMock(
        return_value=MagicMock(
            status_code=200,
            json=lambda: {"status": "completed"},
        )
    )

    result = await client.submit_job_result(
        "job-1",
        {"answer": "done"},
        fencing_token=2,
        idempotency_key="effect-1",
    )

    assert result == {"status": "completed"}
    client._post.assert_awaited_once_with(
        "/api/jobs/job-1/result",
        json={"result": {"answer": "done"}, "fencingToken": 2},
        headers={"Idempotency-Key": "effect-1"},
    )


def test_database_file_is_owner_only_where_supported(tmp_path: Path):
    path = tmp_path / "permissions.db"
    db = LocalDB(path=path)
    mode = os.stat(path).st_mode & 0o777
    db.close()
    assert mode & 0o077 == 0
