"""Tests for the restore reconciliation feature (#296).

Covers three modules:

restore.py — reconcile_after_restore()
    ReconcileConfig defaults, Step 1 (prune completion markers),
    Step 2 (cap stale backoff), Step 3 (validate schedule timestamps),
    Step 4 (verify claimed jobs), db=None raises TypeError,
    full crash-restore integration, idempotency.

db.py — new methods for migration 9
    claimed_jobs CRUD, completion_markers CRUD, Migration 9 table/column checks.

commerce.py — persisted fencing tokens
    set_claimed_job persists to DB, remove_claimed_job removes from DB,
    DB unavailable does not crash.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from talos_agent.db import LocalDB
from talos_agent.restore import (
    ReconcileConfig,
    reconcile_after_restore,
)
from talos_agent.tools import commerce

# ── Helpers ────────────────────────────────────────────────────────────────────

def _fresh_db(tmp_path: Path) -> LocalDB:
    return LocalDB(path=tmp_path / "test.db")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def reset_commerce_state():
    """Clear module-level commerce state before every test."""
    commerce._claimed_jobs.clear()
    original_db = commerce._db
    commerce._db = None
    yield
    commerce._claimed_jobs.clear()
    commerce._db = original_db


# ══════════════════════════════════════════════════════════════════════════════
# Section 1: ReconcileConfig defaults
# ══════════════════════════════════════════════════════════════════════════════

class TestReconcileConfigDefaults:
    def test_default_max_backoff_future_secs(self):
        cfg = ReconcileConfig()
        assert cfg.max_backoff_future_secs == 3_600.0

    def test_default_backoff_cap_secs(self):
        cfg = ReconcileConfig()
        assert cfg.backoff_cap_secs == 60.0

    def test_default_max_clock_skew_secs(self):
        cfg = ReconcileConfig()
        assert cfg.max_clock_skew_secs == 300.0

    def test_default_api_verify_leases(self):
        cfg = ReconcileConfig()
        assert cfg.api_verify_leases is True

    def test_default_api_timeout_secs(self):
        cfg = ReconcileConfig()
        assert cfg.api_timeout_secs == 10.0


# ══════════════════════════════════════════════════════════════════════════════
# Section 2: Step 1 — Prune expired completion markers
# ══════════════════════════════════════════════════════════════════════════════

class TestPruneCompletionMarkers:
    async def test_expired_markers_are_deleted(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # Add an already-expired marker by inserting directly
        past = (_utc_now() - timedelta(days=1)).isoformat()
        db._conn.execute(
            "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) VALUES (?, ?, ?)",
            ("job-1", "idem-1", past),
        )
        db._conn.commit()

        result = await reconcile_after_restore(db, config=ReconcileConfig(api_verify_leases=False))
        assert result.markers_pruned == 1
        assert db.has_completion_marker("idem-1") is False
        db.close()

    async def test_non_expired_markers_are_kept(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-2", "idem-fresh", retain_days=7)

        result = await reconcile_after_restore(db, config=ReconcileConfig(api_verify_leases=False))
        assert result.markers_pruned == 0
        assert db.has_completion_marker("idem-fresh") is True
        db.close()

    async def test_prune_count_returned_in_result(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        past = (_utc_now() - timedelta(days=1)).isoformat()
        for i in range(3):
            db._conn.execute(
                "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) VALUES (?, ?, ?)",
                (f"job-{i}", f"idem-{i}", past),
            )
        db._conn.commit()

        result = await reconcile_after_restore(db, config=ReconcileConfig(api_verify_leases=False))
        assert result.markers_pruned == 3
        db.close()

    async def test_db_error_in_prune_captured_in_errors(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # Patch the method to raise
        original = db.prune_expired_completion_markers
        db.prune_expired_completion_markers = MagicMock(side_effect=RuntimeError("disk full"))

        result = await reconcile_after_restore(db, config=ReconcileConfig(api_verify_leases=False))
        assert any("prune_completion_markers" in e for e in result.errors)
        db.prune_expired_completion_markers = original
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 3: Step 2 — Cap stale backoff timestamps
# ══════════════════════════════════════════════════════════════════════════════

class TestCapStaleBackoff:
    async def test_far_future_next_attempt_at_is_capped(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        far_future = _utc_now() + timedelta(hours=10)
        db.upsert_retry_state("polling", attempt_count=2, next_attempt_at=far_future)

        cfg = ReconcileConfig(
            max_backoff_future_secs=3600,
            backoff_cap_secs=60,
            api_verify_leases=False,
        )
        result = await reconcile_after_restore(db, config=cfg)
        assert result.backoff_rows_capped == 1

        state = db.get_retry_state("polling")
        assert state is not None
        # Should be capped to ~now+60s, not 10 hours from now
        assert state["next_attempt_at"] < _utc_now() + timedelta(seconds=120)
        db.close()

    async def test_within_window_next_attempt_at_is_unchanged(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # 30 minutes in the future — within the 1-hour window
        near_future = _utc_now() + timedelta(minutes=30)
        db.upsert_retry_state("heartbeat", attempt_count=1, next_attempt_at=near_future)

        cfg = ReconcileConfig(
            max_backoff_future_secs=3600,
            backoff_cap_secs=60,
            api_verify_leases=False,
        )
        result = await reconcile_after_restore(db, config=cfg)
        assert result.backoff_rows_capped == 0

        state = db.get_retry_state("heartbeat")
        diff = abs((state["next_attempt_at"] - near_future).total_seconds())
        assert diff < 2.0
        db.close()

    async def test_corrupt_none_next_attempt_at_is_reset(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # Insert a corrupt value directly
        db._conn.execute(
            "INSERT INTO retry_state (task_name, attempt_count, next_attempt_at, terminal) "
            "VALUES (?, ?, ?, ?)",
            ("corrupt_task", 1, "not-a-date", 0),
        )
        db._conn.commit()

        cfg = ReconcileConfig(api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert result.backoff_rows_capped >= 1
        db.close()

    async def test_backoff_rows_capped_incremented_correctly(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        far_future = _utc_now() + timedelta(hours=5)
        db.upsert_retry_state("task_a", attempt_count=1, next_attempt_at=far_future)
        db.upsert_retry_state("task_b", attempt_count=2, next_attempt_at=far_future)
        # task_c within window — should not be capped
        near = _utc_now() + timedelta(minutes=10)
        db.upsert_retry_state("task_c", attempt_count=1, next_attempt_at=near)

        cfg = ReconcileConfig(
            max_backoff_future_secs=3600,
            backoff_cap_secs=60,
            api_verify_leases=False,
        )
        result = await reconcile_after_restore(db, config=cfg)
        assert result.backoff_rows_capped == 2
        db.close()

    async def test_db_error_during_cap_captured_in_errors(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # Break the connection so reads fail
        db._conn.close()

        cfg = ReconcileConfig(api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        # Should have an error captured, not raise
        assert len(result.errors) > 0


# ══════════════════════════════════════════════════════════════════════════════
# Section 4: Step 3 — Validate schedule timestamps
# ══════════════════════════════════════════════════════════════════════════════

class TestValidateScheduleTimestamps:
    async def test_future_last_run_at_reset_to_now(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        far_future = (_utc_now() + timedelta(hours=2)).isoformat()
        db._conn.execute(
            "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
            ("skewed_task", far_future),
        )
        db._conn.commit()

        cfg = ReconcileConfig(max_clock_skew_secs=300, api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert result.schedules_reset == 1

        row = db._conn.execute(
            "SELECT last_run_at FROM schedules WHERE task_name = ?", ("skewed_task",)
        ).fetchone()
        reset_dt = datetime.fromisoformat(row["last_run_at"])
        # Should be within 10s of now
        assert abs((_utc_now() - reset_dt.replace(tzinfo=timezone.utc)).total_seconds()) < 10
        db.close()

    async def test_past_last_run_at_is_untouched(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        past = (_utc_now() - timedelta(hours=1)).isoformat()
        db._conn.execute(
            "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
            ("normal_task", past),
        )
        db._conn.commit()

        cfg = ReconcileConfig(max_clock_skew_secs=300, api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert result.schedules_reset == 0
        db.close()

    async def test_within_tolerance_last_run_at_is_untouched(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # 1 minute in the future — within 300s tolerance
        slightly_future = (_utc_now() + timedelta(minutes=1)).isoformat()
        db._conn.execute(
            "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
            ("close_task", slightly_future),
        )
        db._conn.commit()

        cfg = ReconcileConfig(max_clock_skew_secs=300, api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert result.schedules_reset == 0
        db.close()

    async def test_schedules_reset_incremented(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        far_future = (_utc_now() + timedelta(hours=5)).isoformat()
        for name in ["task_x", "task_y"]:
            db._conn.execute(
                "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
                (name, far_future),
            )
        db._conn.commit()

        cfg = ReconcileConfig(max_clock_skew_secs=300, api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert result.schedules_reset == 2
        db.close()

    async def test_db_error_in_schedule_validation_captured(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db._conn.close()

        cfg = ReconcileConfig(api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)
        assert len(result.errors) > 0


# ══════════════════════════════════════════════════════════════════════════════
# Section 5: Step 4 — Verify claimed jobs
# ══════════════════════════════════════════════════════════════════════════════

class TestVerifyClaimedJobs:
    async def test_api_verify_false_restores_unconditionally(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("job-1", fencing_token=42, ttl_seconds=300)

        cfg = ReconcileConfig(api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)

        assert result.claimed_jobs_restored == 1
        assert commerce._claimed_jobs.get("job-1") == 42
        db.close()

    async def test_api_none_restores_unconditionally(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("job-2", fencing_token=7, ttl_seconds=300)

        cfg = ReconcileConfig(api_verify_leases=True)
        result = await reconcile_after_restore(db, api=None, config=cfg)

        assert result.claimed_jobs_restored == 1
        assert commerce._claimed_jobs.get("job-2") == 7
        db.close()

    async def test_empty_claimed_jobs_no_api_calls(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        mock_api = AsyncMock()

        cfg = ReconcileConfig(api_verify_leases=True)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_found == 0
        mock_api.heartbeat_job.assert_not_called()
        db.close()

    async def test_locally_expired_lease_dropped_from_db(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        past_expiry = _utc_now() - timedelta(seconds=60)
        db.upsert_claimed_job(
            "job-expired", fencing_token=99, ttl_seconds=300,
            lease_expires_at=past_expiry,
        )
        mock_api = AsyncMock()

        cfg = ReconcileConfig(api_verify_leases=True)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_dropped == 1
        assert commerce._claimed_jobs.get("job-expired") is None
        assert db.get_claimed_job("job-expired") is None
        # No API call needed since already expired locally
        mock_api.heartbeat_job.assert_not_called()
        db.close()

    async def test_api_heartbeat_truthy_restores_to_memory(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        future_expiry = _utc_now() + timedelta(seconds=300)
        db.upsert_claimed_job(
            "job-live", fencing_token=55, ttl_seconds=300,
            lease_expires_at=future_expiry,
        )
        mock_api = AsyncMock()
        mock_api.heartbeat_job = AsyncMock(return_value=True)

        cfg = ReconcileConfig(api_verify_leases=True, api_timeout_secs=5)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_restored == 1
        assert commerce._claimed_jobs.get("job-live") == 55
        db.close()

    async def test_api_heartbeat_falsy_drops_and_deletes_from_db(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        future_expiry = _utc_now() + timedelta(seconds=300)
        db.upsert_claimed_job(
            "job-lost", fencing_token=11, ttl_seconds=300,
            lease_expires_at=future_expiry,
        )
        mock_api = AsyncMock()
        mock_api.heartbeat_job = AsyncMock(return_value=False)

        cfg = ReconcileConfig(api_verify_leases=True, api_timeout_secs=5)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_dropped == 1
        assert commerce._claimed_jobs.get("job-lost") is None
        assert db.get_claimed_job("job-lost") is None
        db.close()

    async def test_api_timeout_defers_keeps_db_row_not_in_memory(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        future_expiry = _utc_now() + timedelta(seconds=300)
        db.upsert_claimed_job(
            "job-slow", fencing_token=22, ttl_seconds=300,
            lease_expires_at=future_expiry,
        )
        mock_api = AsyncMock()
        mock_api.heartbeat_job = AsyncMock(side_effect=asyncio.TimeoutError())

        cfg = ReconcileConfig(api_verify_leases=True, api_timeout_secs=5)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_deferred == 1
        assert commerce._claimed_jobs.get("job-slow") is None
        # DB row must be kept
        assert db.get_claimed_job("job-slow") is not None
        db.close()

    async def test_api_generic_exception_defers_with_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        future_expiry = _utc_now() + timedelta(seconds=300)
        db.upsert_claimed_job(
            "job-err", fencing_token=33, ttl_seconds=300,
            lease_expires_at=future_expiry,
        )
        mock_api = AsyncMock()
        mock_api.heartbeat_job = AsyncMock(side_effect=RuntimeError("connection reset"))

        cfg = ReconcileConfig(api_verify_leases=True, api_timeout_secs=5)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_deferred == 1
        assert any("job-err" in e for e in result.errors)
        assert commerce._claimed_jobs.get("job-err") is None
        assert db.get_claimed_job("job-err") is not None
        db.close()

    async def test_multiple_jobs_mix_of_outcomes(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        future_expiry = _utc_now() + timedelta(seconds=300)
        past_expiry = _utc_now() - timedelta(seconds=60)

        db.upsert_claimed_job("job-ok", fencing_token=1, ttl_seconds=300,
                              lease_expires_at=future_expiry)
        db.upsert_claimed_job("job-lost2", fencing_token=2, ttl_seconds=300,
                              lease_expires_at=future_expiry)
        db.upsert_claimed_job("job-expired2", fencing_token=3, ttl_seconds=300,
                              lease_expires_at=past_expiry)
        db.upsert_claimed_job("job-timeout", fencing_token=4, ttl_seconds=300,
                              lease_expires_at=future_expiry)

        async def _heartbeat(job_id, fencing_token):
            if job_id == "job-ok":
                return True
            if job_id == "job-lost2":
                return False
            if job_id == "job-timeout":
                raise asyncio.TimeoutError()

        mock_api = AsyncMock()
        mock_api.heartbeat_job = AsyncMock(side_effect=_heartbeat)

        cfg = ReconcileConfig(api_verify_leases=True, api_timeout_secs=5)
        result = await reconcile_after_restore(db, api=mock_api, config=cfg)

        assert result.claimed_jobs_found == 4
        assert result.claimed_jobs_restored == 1   # job-ok
        assert result.claimed_jobs_dropped == 2    # job-lost2 + job-expired2
        assert result.claimed_jobs_deferred == 1   # job-timeout
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 6: db=None raises TypeError
# ══════════════════════════════════════════════════════════════════════════════

class TestReconcileDbNone:
    async def test_none_db_raises_type_error(self):
        with pytest.raises(TypeError):
            await reconcile_after_restore(None)  # type: ignore[arg-type]


# ══════════════════════════════════════════════════════════════════════════════
# Section 7: Full integration — crash-restore simulation
# ══════════════════════════════════════════════════════════════════════════════

class TestCrashRestoreIntegration:
    async def test_job_restored_after_simulated_crash(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        commerce._db = db

        # 1. "Claim" a job — persists to DB and memory
        await commerce.set_claimed_job("crash-job", fencing_token=77, ttl_seconds=300)
        assert commerce._claimed_jobs.get("crash-job") == 77
        assert db.get_claimed_job("crash-job") is not None

        # 2. Simulate crash: wipe in-memory state
        commerce._claimed_jobs.clear()
        assert commerce._claimed_jobs.get("crash-job") is None

        # 3. Reconcile — should restore from DB
        cfg = ReconcileConfig(api_verify_leases=False)
        result = await reconcile_after_restore(db, config=cfg)

        assert result.claimed_jobs_restored == 1
        assert commerce._claimed_jobs.get("crash-job") == 77
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 8: Idempotency
# ══════════════════════════════════════════════════════════════════════════════

class TestReconcileIdempotency:
    async def test_two_passes_produce_same_net_result(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("idem-job", fencing_token=5, ttl_seconds=300)

        cfg = ReconcileConfig(api_verify_leases=False)

        result1 = await reconcile_after_restore(db, config=cfg)
        # Reset memory between passes to simulate fresh start
        commerce._claimed_jobs.clear()
        result2 = await reconcile_after_restore(db, config=cfg)

        assert result1.claimed_jobs_restored == result2.claimed_jobs_restored
        assert result1.claimed_jobs_dropped == result2.claimed_jobs_dropped
        assert commerce._claimed_jobs.get("idem-job") == 5
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 9: db.py — claimed_jobs CRUD
# ══════════════════════════════════════════════════════════════════════════════

class TestClaimedJobsCRUD:
    def test_upsert_claimed_job_stores_row(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("j1", fencing_token=10, ttl_seconds=60)
        row = db.get_claimed_job("j1")
        assert row is not None
        assert row["job_id"] == "j1"
        assert row["fencing_token"] == 10
        assert row["ttl_seconds"] == 60
        db.close()

    def test_get_claimed_job_returns_datetime_fields_parsed(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        expiry = _utc_now() + timedelta(seconds=120)
        db.upsert_claimed_job("j2", fencing_token=5, ttl_seconds=120, lease_expires_at=expiry)
        row = db.get_claimed_job("j2")
        assert isinstance(row["claimed_at"], datetime)
        assert isinstance(row["lease_expires_at"], datetime)
        db.close()

    def test_get_all_claimed_jobs_returns_all_rows(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("j3", fencing_token=1, ttl_seconds=60)
        db.upsert_claimed_job("j4", fencing_token=2, ttl_seconds=60)
        rows = db.get_all_claimed_jobs()
        job_ids = {r["job_id"] for r in rows}
        assert {"j3", "j4"} == job_ids
        db.close()

    def test_delete_claimed_job_removes_row(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("j5", fencing_token=99, ttl_seconds=60)
        db.delete_claimed_job("j5")
        assert db.get_claimed_job("j5") is None
        db.close()

    def test_upsert_same_job_id_updates_row(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.upsert_claimed_job("j6", fencing_token=1, ttl_seconds=60)
        db.upsert_claimed_job("j6", fencing_token=2, ttl_seconds=120)
        row = db.get_claimed_job("j6")
        assert row["fencing_token"] == 2
        assert row["ttl_seconds"] == 120
        db.close()

    def test_upsert_empty_job_id_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.upsert_claimed_job("", fencing_token=1, ttl_seconds=60)
        db.close()

    def test_upsert_negative_fencing_token_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.upsert_claimed_job("j7", fencing_token=-1, ttl_seconds=60)
        db.close()

    def test_upsert_zero_ttl_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.upsert_claimed_job("j8", fencing_token=1, ttl_seconds=0)
        db.close()

    def test_upsert_negative_ttl_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.upsert_claimed_job("j9", fencing_token=1, ttl_seconds=-10)
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 10: db.py — completion_markers CRUD
# ══════════════════════════════════════════════════════════════════════════════

class TestCompletionMarkersCRUD:
    def test_add_completion_marker_creates_row(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-a", "key-a", retain_days=7)
        assert db.has_completion_marker("key-a") is True
        db.close()

    def test_add_completion_marker_correct_expiry(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        before = _utc_now()
        db.add_completion_marker("job-b", "key-b", retain_days=3)
        row = db._conn.execute(
            "SELECT expires_at FROM completion_markers WHERE idempotency_key = ?", ("key-b",)
        ).fetchone()
        assert row is not None
        expires_dt = datetime.fromisoformat(row["expires_at"])
        if expires_dt.tzinfo is None:
            expires_dt = expires_dt.replace(tzinfo=timezone.utc)
        expected_min = before + timedelta(days=3) - timedelta(seconds=5)
        expected_max = _utc_now() + timedelta(days=3) + timedelta(seconds=5)
        assert expected_min <= expires_dt <= expected_max
        db.close()

    def test_has_completion_marker_true_for_non_expired(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-c", "key-c", retain_days=7)
        assert db.has_completion_marker("key-c") is True
        db.close()

    def test_has_completion_marker_false_for_expired(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        past = (_utc_now() - timedelta(days=1)).isoformat()
        db._conn.execute(
            "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) VALUES (?, ?, ?)",
            ("job-d", "key-d", past),
        )
        db._conn.commit()
        assert db.has_completion_marker("key-d") is False
        db.close()

    def test_get_completion_markers_for_job_returns_non_expired(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-e", "key-e1", retain_days=7)
        db.add_completion_marker("job-e", "key-e2", retain_days=7)
        # Add expired one
        past = (_utc_now() - timedelta(days=1)).isoformat()
        db._conn.execute(
            "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) VALUES (?, ?, ?)",
            ("job-e", "key-e-expired", past),
        )
        db._conn.commit()

        rows = db.get_completion_markers_for_job("job-e")
        keys = {r["idempotency_key"] for r in rows}
        assert "key-e1" in keys
        assert "key-e2" in keys
        assert "key-e-expired" not in keys
        db.close()

    def test_prune_expired_markers_deletes_only_expired(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-f", "key-fresh", retain_days=7)
        past = (_utc_now() - timedelta(days=1)).isoformat()
        db._conn.execute(
            "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) VALUES (?, ?, ?)",
            ("job-f", "key-old", past),
        )
        db._conn.commit()

        count = db.prune_expired_completion_markers()
        assert count == 1
        assert db.has_completion_marker("key-fresh") is True
        assert db.has_completion_marker("key-old") is False
        db.close()

    def test_add_duplicate_idempotency_key_raises_integrity_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.add_completion_marker("job-g", "key-dup", retain_days=7)
        with pytest.raises(sqlite3.IntegrityError):
            db.add_completion_marker("job-g", "key-dup", retain_days=7)
        db.close()

    def test_add_completion_marker_empty_job_id_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.add_completion_marker("", "key-x", retain_days=7)
        db.close()

    def test_add_completion_marker_empty_idempotency_key_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.add_completion_marker("job-h", "", retain_days=7)
        db.close()

    def test_add_completion_marker_zero_retain_days_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.add_completion_marker("job-i", "key-y", retain_days=0)
        db.close()

    def test_add_completion_marker_negative_retain_days_raises_value_error(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        with pytest.raises(ValueError):
            db.add_completion_marker("job-j", "key-z", retain_days=-1)
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 11: db.py — Migration 9 table and column checks
# ══════════════════════════════════════════════════════════════════════════════

class TestMigration9:
    def test_claimed_jobs_table_exists_after_init(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        row = db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='claimed_jobs'"
        ).fetchone()
        assert row is not None
        db.close()

    def test_completion_markers_table_exists_after_init(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        row = db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='completion_markers'"
        ).fetchone()
        assert row is not None
        db.close()

    def test_claimed_jobs_correct_columns(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        rows = db._conn.execute("PRAGMA table_info(claimed_jobs)").fetchall()
        cols = {r[1] for r in rows}
        expected = {"job_id", "fencing_token", "claimed_at", "lease_expires_at", "ttl_seconds"}
        assert expected == cols
        db.close()

    def test_completion_markers_correct_columns(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        rows = db._conn.execute("PRAGMA table_info(completion_markers)").fetchall()
        cols = {r[1] for r in rows}
        expected = {"id", "job_id", "idempotency_key", "completed_at", "expires_at"}
        assert expected == cols
        db.close()


# ══════════════════════════════════════════════════════════════════════════════
# Section 12: commerce.py — persisted fencing tokens
# ══════════════════════════════════════════════════════════════════════════════

class TestCommercePersistedFencingTokens:
    async def test_set_claimed_job_persists_to_db(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        commerce._db = db
        await commerce.set_claimed_job("cj-1", fencing_token=100, ttl_seconds=120)

        row = db.get_claimed_job("cj-1")
        assert row is not None
        assert row["fencing_token"] == 100
        db.close()

    async def test_set_claimed_job_updates_memory_dict(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        commerce._db = db
        await commerce.set_claimed_job("cj-2", fencing_token=200, ttl_seconds=60)

        assert commerce._claimed_jobs.get("cj-2") == 200
        db.close()

    async def test_remove_claimed_job_removes_from_db(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        commerce._db = db
        await commerce.set_claimed_job("cj-3", fencing_token=300, ttl_seconds=60)
        assert db.get_claimed_job("cj-3") is not None

        await commerce.remove_claimed_job("cj-3")
        assert db.get_claimed_job("cj-3") is None
        db.close()

    async def test_remove_claimed_job_removes_from_memory(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        commerce._db = db
        await commerce.set_claimed_job("cj-4", fencing_token=400, ttl_seconds=60)
        assert "cj-4" in commerce._claimed_jobs

        await commerce.remove_claimed_job("cj-4")
        assert "cj-4" not in commerce._claimed_jobs
        db.close()

    async def test_set_claimed_job_db_none_updates_memory(self):
        # _db is None (already set by autouse fixture)
        assert commerce._db is None
        await commerce.set_claimed_job("cj-5", fencing_token=500, ttl_seconds=60)
        assert commerce._claimed_jobs.get("cj-5") == 500
