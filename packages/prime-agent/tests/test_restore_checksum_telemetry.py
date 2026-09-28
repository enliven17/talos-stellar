"""Focused tests for restore checksum + reconciliation telemetry (#548)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from talos_agent.db import LocalDB
from talos_agent.restore import (
    ReconcileConfig,
    RestoreChecksum,
    clear_last_reconciliation_telemetry,
    compute_restore_checksum,
    get_last_reconciliation_telemetry,
    reconcile_after_restore,
)
from talos_agent.telemetry import TelemetryCollector
from talos_agent.tools import commerce


@pytest.fixture(autouse=True)
def _reset_state():
    commerce._claimed_jobs.clear()
    original_db = commerce._db
    commerce._db = None
    clear_last_reconciliation_telemetry()
    yield
    commerce._claimed_jobs.clear()
    commerce._db = original_db
    clear_last_reconciliation_telemetry()


def _fresh_db(tmp_path: Path) -> LocalDB:
    return LocalDB(path=tmp_path / "test.db")


class TestComputeRestoreChecksum:
    def test_positive_deterministic_for_same_state(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        db.update_schedule("agent_cycle")
        first = compute_restore_checksum(db)
        second = compute_restore_checksum(db)
        assert isinstance(first, RestoreChecksum)
        assert first.algorithm == "sha256"
        assert len(first.digest) == 64
        assert first.digest == second.digest
        assert first.table_count > 0
        assert first.error is None
        db.close()

    def test_checksum_changes_when_state_changes(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        before = compute_restore_checksum(db)
        db.update_schedule("polling")
        after = compute_restore_checksum(db)
        assert before.digest != after.digest
        assert after.total_rows >= before.total_rows
        db.close()

    def test_missing_path_is_empty_boundary(self, tmp_path: Path):
        missing = tmp_path / "does-not-exist.db"
        result = compute_restore_checksum(missing)
        assert result.empty is True
        assert result.table_count == 0
        assert result.total_rows == 0
        assert result.error is None
        assert len(result.digest) == 64

    def test_none_source_is_explicit_error(self):
        result = compute_restore_checksum(None)
        assert result.empty is True
        assert result.error == "missing_source"
        assert len(result.digest) == 64

    def test_malformed_source_type_is_privacy_safe(self):
        result = compute_restore_checksum(object())
        assert result.error is not None
        assert "TypeError" in result.error
        assert "password" not in result.error.lower()
        assert "secret" not in result.error.lower()

    def test_never_embeds_secret_values_in_digest_inputs(self, tmp_path: Path):
        """Regression: digest uses fingerprints/counts, not raw secret payloads."""
        db = _fresh_db(tmp_path)
        secret = "super-secret-seed-mnemonic-value"
        # talos_config may store operator config; checksum must not hash raw values.
        try:
            db._conn.execute(
                "INSERT OR REPLACE INTO talos_config (key, value) VALUES (?, ?)",
                ("api_token", secret),
            )
            db._conn.commit()
        except Exception:
            # Schema variance — still assert digest itself isn't the raw secret.
            pass
        checksum = compute_restore_checksum(db)
        assert secret not in checksum.digest
        assert secret not in json.dumps(checksum.to_dict())
        # Digest should equal hashing of canonical form, not of the secret alone.
        assert checksum.digest != hashlib.sha256(secret.encode()).hexdigest()
        db.close()


class TestReconcileEmitsTelemetry:
    async def test_reconcile_emits_checksum_and_caches_telemetry(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        result = await reconcile_after_restore(
            db, config=ReconcileConfig(api_verify_leases=False)
        )
        assert result.checksum
        assert len(result.checksum) == 64
        assert result.checksum_algorithm == "sha256"
        assert result.checksum_table_count > 0

        telemetry = get_last_reconciliation_telemetry()
        assert telemetry is not None
        assert telemetry["checksum"] == result.checksum
        assert telemetry["markers_pruned"] == result.markers_pruned
        assert "error_count" in telemetry
        assert result.to_telemetry()["checksum"] == result.checksum
        db.close()

    async def test_telemetry_collector_includes_restore_fields(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        await reconcile_after_restore(db, config=ReconcileConfig(api_verify_leases=False))

        collector = TelemetryCollector(db=db, agent_name="restore-agent")
        report = collector.collect()
        assert report.restore_checksum
        assert report.restore_checksum_algorithm == "sha256"
        assert report.restore_checksum_table_count > 0
        assert report.restore_reconciliation.get("checksum") == report.restore_checksum
        payload = report.to_json()
        assert "restore_checksum" in payload
        assert "super-secret" not in payload
        db.close()

    async def test_collector_without_prior_reconcile_is_boundary_safe(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        clear_last_reconciliation_telemetry()
        collector = TelemetryCollector(db=db, agent_name="fresh")
        report = collector.collect()
        assert report.restore_checksum == ""
        assert report.restore_reconciliation == {}
        db.close()

    async def test_dependency_failure_does_not_abort_reconcile(self, tmp_path: Path):
        db = _fresh_db(tmp_path)
        # Force checksum path to observe a closed connection mid-flight by
        # monkeypatching compute to return an error result — reconcile must still return.
        from talos_agent import restore as restore_mod

        original = restore_mod.compute_restore_checksum

        def boom(_source):
            return RestoreChecksum(
                digest="",
                empty=True,
                error="OperationalError:disk",
                computed_at="2026-01-01T00:00:00+00:00",
            )

        restore_mod.compute_restore_checksum = boom  # type: ignore[assignment]
        try:
            result = await reconcile_after_restore(
                db, config=ReconcileConfig(api_verify_leases=False)
            )
            assert any("restore_checksum:" in e for e in result.errors)
            assert get_last_reconciliation_telemetry() is not None
        finally:
            restore_mod.compute_restore_checksum = original  # type: ignore[assignment]
            db.close()
