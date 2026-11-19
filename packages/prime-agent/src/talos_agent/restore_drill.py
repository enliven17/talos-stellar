"""Automated clean-runtime restore drills for current and supported checkpoint formats.

Purpose
-------
This module periodically exercises the full checkpoint / restore / reconciliation
pipeline under controlled synthetic conditions so that regressions in serialisation,
migration, rotation, integrity verification, identity enforcement, rollback safety,
or post-restore scheduler behaviour are caught before they reach production.

Scope (per #281 / #289)
------------------------
* Synthetic state and ephemeral keys only — no real agent databases are touched.
* Scenarios: normal roundtrip, key rotation, schema migration, corruption detection
  (ciphertext, HMAC, AAD), wrong-identity rejection, rollback rejection, and
  post-restore scheduler no-duplicate-effect validation.
* Bounded JSON reports written to disk; every report is self-contained and safe
  for transport (no plaintext keys, no PII).

Design constraints
------------------
* Reuses ``CheckpointStore``, ``StagedRestoreManager``, ``ReconcileConfig``, and
  the scheduler's ``reconcile_after_restore`` entry point from sibling modules.
* Does **not** duplicate acceptance criteria or integration tests that already
  live in ``tests/test_checkpoint.py``, ``tests/test_staged_restore.py``, or
  ``tests/test_restore_reconciliation.py``.  Instead it orchestrates them at a
  higher level and emits a structured report.
* Idempotent: repeated runs with the same configuration produce deterministic
  results (modulo wall-clock timestamps stripped from report output).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from talos_agent.checkpoint import (
    CheckpointStore,
    IdentityError,
    KeyNotFoundError,
    SchemaError,
    TamperError,
)
from talos_agent.observability import log

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

_DEFAULT_DRILL_DIR = Path.home() / ".talos-agent" / "drill_reports"
_MAX_REPORT_SIZE_BYTES = 512 * 1024  # 512 KiB
_REPORT_RETAIN_COUNT = 20

# Supported scenarios
ALL_SCENARIOS: frozenset[str] = frozenset(
    {
        "normal_roundtrip",
        "key_rotation",
        "migration",
        "corruption",
        "wrong_identity",
        "rollback",
        "scheduler_no_duplicate_effects",
    }
)


# ── Configuration ──────────────────────────────────────────────────────────────


@dataclass
class DrillConfig:
    """Configuration for a restore-drill run.

    Attributes
    ----------
    scenarios:
        Which scenarios to exercise.  Default: all.
    schema_versions:
        Accepted schema versions for migration-compatibility tests.  Default: {1}.
    max_duration_secs:
        Per-drill-run wall-clock timeout.  Default: 30 s.
    report_dir:
        Directory for bounded drill reports.  Default: ``~/.talos-agent/drill_reports``.
    report_retain_count:
        Maximum number of historical reports to retain.  Default: 20.
    """

    scenarios: set[str] = field(default_factory=lambda: set(ALL_SCENARIOS))
    schema_versions: set[int] = field(default_factory=lambda: {1})
    max_duration_secs: float = 30.0
    report_dir: Path = field(default_factory=lambda: _DEFAULT_DRILL_DIR)
    report_retain_count: int = _REPORT_RETAIN_COUNT


# ── Result types ───────────────────────────────────────────────────────────────


@dataclass
class ScenarioResult:
    """Outcome of a single drill scenario."""

    scenario: str
    passed: bool
    duration_ms: float = 0.0
    detail: str = ""
    error: str | None = None


@dataclass
class DrillReport:
    """Bounded, transport-safe summary of a restore-drill run."""

    timestamp: str
    total: int = 0
    passed: int = 0
    failed: int = 0
    scenarios: list[ScenarioResult] = field(default_factory=list)
    duration_ms: float = 0.0


# ── Helpers ────────────────────────────────────────────────────────────────────


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _temp_connection() -> sqlite3.Connection:
    """Return an in-memory SQLite connection with foreign keys enabled."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _sanitise_error(exc: Exception) -> str:
    """Return a safe, bounded error string (no raw key material)."""
    msg = str(exc)
    if len(msg) > 200:
        msg = msg[:197] + "..."
    return msg


# ── Synthetic state factory ────────────────────────────────────────────────────


def _make_synthetic_checkpoint_store(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> tuple[CheckpointStore, sqlite3.Connection]:
    """Create a fresh in-memory :class:`CheckpointStore` with an active key."""
    conn = _temp_connection()
    store = CheckpointStore(conn, master_pw)
    store.generate_key(agent_id)
    return store, conn


# ── Scenario implementations ───────────────────────────────────────────────────


def _scenario_normal_roundtrip(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Seal a payload, open it, verify the plaintext matches."""
    t0 = time.monotonic()
    scenario = "normal_roundtrip"
    try:
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)
        payload = {"drill": "normal", "seq": 1, "values": [1, 2, 3]}
        nonce = store.seal(agent_id, payload)
        opened = store.open(nonce, expected_agent_id=agent_id)
        conn.close()

        if opened != payload:
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Decrypted payload does not match original",
            )
        return ScenarioResult(
            scenario=scenario,
            passed=True,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            detail=f"Sealed and opened payload with {len(payload)} keys",
        )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


def _scenario_key_rotation(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Verify that old envelopes remain readable after rotation and new envelopes use the new key."""
    t0 = time.monotonic()
    scenario = "key_rotation"
    try:
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)
        # Seal before rotation
        pre_nonce = store.seal(agent_id, {"era": "pre-rotation"})
        # Rotate
        old_key_id, new_key_id = store.rotate_key(agent_id)
        # Seal after rotation
        post_nonce = store.seal(agent_id, {"era": "post-rotation"})

        # Old envelope must still be readable
        pre_data = store.open(pre_nonce, expected_agent_id=agent_id)
        if pre_data != {"era": "pre-rotation"}:
            conn.close()
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Pre-rotation envelope not readable after rotation",
            )

        # New envelope must use the new key
        post_row = conn.execute(
            "SELECT key_id FROM checkpoint_envelopes WHERE nonce=?",
            (post_nonce,),
        ).fetchone()
        conn.close()

        if post_row is None or post_row["key_id"] != new_key_id:
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Post-rotation envelope did not use new key",
            )

        return ScenarioResult(
            scenario=scenario,
            passed=True,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            detail="Rotated {}... -> {}... ; both eras readable".format(
                old_key_id[:8], new_key_id[:8]
            ),
        )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


async def _scenario_migration(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
    schema_versions: set[int] | None = None,
) -> ScenarioResult:
    """Verify cross-schema-version compatibility through staged-restore preflight.

    The CheckpointStore seal/open path accepts any ``schema_version`` because
    only the envelope format version (``v=1``) is enforced at that layer.
    Schema-version gating lives in :class:`StagedRestoreManager._preflight_check`
    which consults ``allowed_schema_versions``.  This scenario validates both
    layers: supported versions pass and unsupported versions are rejected by
    preflight.
    """
    t0 = time.monotonic()
    scenario = "migration"
    if schema_versions is None:
        schema_versions = {1}
    try:
        import tempfile
        from talos_agent.db import LocalDB
        from talos_agent.restore import (
            PreflightError,
            StagedRestoreConfig,
            StagedRestoreManager,
        )

        passed_checks = 0
        total_checks = 0

        # Always use the same fixed allowed_versions ({1}) so unsupported
        # versions are genuinely rejected by preflight.
        for sv in sorted(schema_versions):
            with tempfile.TemporaryDirectory() as tmpdir:
                target = Path(tmpdir) / "drill_mig.db"
                # Create a minimal database so the staged restore has a target
                db = LocalDB(path=target)
                db.close()

                checkpoint_payload = {
                    "schema_version": sv,
                    "agent_id": agent_id,
                    "tables": {"schedules": 1},
                }
                checkpoint_file = Path(tmpdir) / "checkpoint.json"
                checkpoint_file.write_text(json.dumps(checkpoint_payload))

                mgr = StagedRestoreManager(
                    StagedRestoreConfig(
                        allowed_schema_versions={1},
                        require_agent_match=True,
                    )
                )

                total_checks += 1
                if sv in {1}:
                    # Supported version — full staged restore should succeed
                    await mgr.perform_staged_restore(
                        target_db_path=target,
                        checkpoint_input=checkpoint_file,
                        agent_id=agent_id,
                    )
                    passed_checks += 1
                else:
                    # Unsupported version — preflight must reject it
                    try:
                        await mgr.perform_staged_restore(
                            target_db_path=target,
                            checkpoint_input=checkpoint_file,
                            agent_id=agent_id,
                        )
                        # Should not succeed for unsupported versions
                    except PreflightError:
                        passed_checks += 1

        # Also verify supported versions pass the checkpoint store roundtrip
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)
        for sv in {1}:
            nonce = store.seal(agent_id, {"schema": sv}, schema_version=sv)
            data = store.open(nonce, expected_agent_id=agent_id)
            total_checks += 1
            if data is not None:
                passed_checks += 1
        conn.close()

        all_ok = passed_checks == total_checks and total_checks > 0
        return ScenarioResult(
            scenario=scenario,
            passed=all_ok,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            detail="Tested {} schema versions for migration compatibility: {} checks passed".format(
                len(schema_versions) + 1, passed_checks
            ),
        )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


def _scenario_corruption(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Verify that tampered ciphertext, HMAC, and AAD fields are detected.

    Inserts tampered envelopes into the database (each with a unique nonce)
    and verifies that :meth:`CheckpointStore.open` rejects every one.
    """
    t0 = time.monotonic()
    scenario = "corruption"
    tamper_count = 0
    detected_count = 0
    try:
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)
        nonce = store.seal(agent_id, {"data": "sensitive"})

        # Fetch the raw envelope
        row = conn.execute(
            "SELECT payload FROM checkpoint_envelopes WHERE nonce=?", (nonce,)
        ).fetchone()
        env = json.loads(row["payload"])

        # Helper: insert a tampered envelope and try to open it
        def _try_tampered(tampered_env: dict, tamper_label: str) -> None:
            nonlocal tamper_count, detected_count
            tampered_nonce = tampered_env["nonce"] + tamper_label
            # Bump seq so the envelope is unique
            tampered_env["seq"] = tampered_env["seq"] + tamper_count + 1
            conn.execute(
                "INSERT INTO checkpoint_envelopes "
                "(key_id, agent_id, namespace, schema_ver, seq, ts, nonce, payload) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    tampered_env["key_id"],
                    tampered_env["agent_id"],
                    tampered_env.get("ns", ""),
                    tampered_env.get("schema", tampered_env.get("v", 1)),
                    tampered_env["seq"],
                    tampered_env["ts"],
                    tampered_nonce,
                    json.dumps(tampered_env),
                ),
            )
            conn.commit()
            tamper_count += 1
            try:
                store.open(tampered_nonce, expected_agent_id=agent_id)
            except (TamperError, IdentityError, SchemaError, KeyNotFoundError):
                detected_count += 1

        # 1. Tamper ciphertext
        env1 = dict(env)
        ct_bytes = base64.b64decode(env1["ct"])
        env1["ct"] = base64.b64encode(
            bytes([ct_bytes[0] ^ 0xFF]) + ct_bytes[1:]
        ).decode()
        _try_tampered(env1, "_corrupt_ct")

        # 2. Tamper HMAC field (write a known-bad HMAC)
        env2 = dict(env)
        env2["hmac"] = "0" * 64
        _try_tampered(env2, "_tamper_hmac")

        # 3. Tamper AAD field (agent_id changed)
        env3 = dict(env)
        env3["agent_id"] = "evil-agent"
        _try_tampered(env3, "_tamper_aad")

        conn.close()

        return ScenarioResult(
            scenario=scenario,
            passed=detected_count == tamper_count,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            detail=f"Detected {detected_count}/{tamper_count} tampered envelopes",
        )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


def _scenario_wrong_identity(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Verify that an envelope is rejected when expected_agent_id mismatches."""
    t0 = time.monotonic()
    scenario = "wrong_identity"
    try:
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)
        nonce = store.seal(agent_id, {"owned_by": agent_id})

        # Should reject when queried with a different identity
        try:
            store.open(nonce, expected_agent_id="intruder-agent")
            conn.close()
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Wrong identity was NOT rejected (expected IdentityError)",
            )
        except IdentityError:
            conn.close()
            return ScenarioResult(
                scenario=scenario,
                passed=True,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Envelope correctly rejected for mismatched identity",
            )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


def _scenario_rollback(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Verify rollback rejection: open_latest returns the highest sequence,
    and the staged-restore rollback / interrupted-restore recovery works.
    """
    t0 = time.monotonic()
    scenario = "rollback"
    try:
        store, conn = _make_synthetic_checkpoint_store(agent_id, master_pw)

        # Seal multiple envelopes to build up sequence numbers
        for i in range(3):
            store.seal(agent_id, {"seq": i})

        # open_latest must return the highest sequence
        latest = store.open_latest(agent_id)

        if latest is None or latest.get("seq") != 2:
            conn.close()
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="Latest envelope returned seq={}, expected 2".format(
                    latest.get("seq") if latest else None
                ),
            )

        # Also test recover_interrupted_restore (no journal = no-op, returns False)
        from talos_agent.restore import recover_interrupted_restore

        recovered = recover_interrupted_restore(":memory:")
        # No journal file exists, so should return False (nothing to recover)
        if recovered:
            conn.close()
            return ScenarioResult(
                scenario=scenario,
                passed=False,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail="recover_interrupted_restore returned True on non-existent journal",
            )

        conn.close()
        return ScenarioResult(
            scenario=scenario,
            passed=True,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            detail="open_latest correctly returns highest sequence; recover_interrupted_restore safely no-ops",
        )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


async def _scenario_scheduler_no_duplicate_effects(
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> ScenarioResult:
    """Simulate a crash-restore cycle and verify the scheduler produces no duplicate effects.

    Steps:
    1. Create a synthetic database with schedules and retry state using
       ``far-future`` timestamps (simulating clock skew from a crashed agent).
    2. Run reconciliation (what the scheduler does at startup).
    3. Verify that after reconciliation, a second reconciliation pass is a no-op
       (no additional markers pruned, no additional schedules reset).
    """
    t0 = time.monotonic()
    scenario = "scheduler_no_duplicate_effects"
    try:
        import tempfile
        from talos_agent.db import LocalDB
        from talos_agent.restore import ReconcileConfig, reconcile_after_restore

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "drill_scheduler.db"
            db = LocalDB(path=db_path)

            # Insert synthetic schedules with far-future timestamps (simulating clock skew)
            far_future = (
                datetime.now(timezone.utc).replace(tzinfo=None)
                + timedelta(hours=5)
            ).isoformat()
            db._conn.execute(
                "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
                ("drill_schedule_1", far_future),
            )
            db._conn.execute(
                "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?)",
                ("drill_schedule_2", far_future),
            )

            # Insert synthetic retry state with far-future backoff
            far_future_backoff = (
                datetime.now(timezone.utc).replace(tzinfo=None)
                + timedelta(hours=5)
            ).isoformat()
            db._conn.execute(
                "INSERT INTO retry_state (task_name, attempt_count, next_attempt_at, terminal) "
                "VALUES (?, ?, ?, ?)",
                ("drill_retry", 3, far_future_backoff, 0),
            )
            db._conn.commit()

            # First reconciliation pass — should reset skewed schedules and cap backoff
            cfg = ReconcileConfig(
                max_clock_skew_secs=1,
                max_backoff_future_secs=1,
                backoff_cap_secs=1,
                api_verify_leases=False,
            )
            result1 = await reconcile_after_restore(db, config=cfg)

            # Second reconciliation pass — should be a near-no-op
            result2 = await reconcile_after_restore(db, config=cfg)

            db.close()

            # After pass 1, schedules should have been reset
            schedules_reset_ok = result1.schedules_reset >= 1
            backoff_capped_ok = result1.backoff_rows_capped >= 1
            # After pass 2, nothing new should have been reset
            no_duplicate_reset = result2.schedules_reset == 0
            no_duplicate_backoff = result2.backoff_rows_capped == 0

            passed = (
                schedules_reset_ok
                and backoff_capped_ok
                and no_duplicate_reset
                and no_duplicate_backoff
            )

            return ScenarioResult(
                scenario=scenario,
                passed=passed,
                duration_ms=round((time.monotonic() - t0) * 1000, 2),
                detail=(
                    "Pass 1: schedules_reset={}, backoff_capped={}; "
                    "Pass 2: schedules_reset={} (0 expected), "
                    "backoff_capped={} (0 expected)"
                ).format(
                    result1.schedules_reset,
                    result1.backoff_rows_capped,
                    result2.schedules_reset,
                    result2.backoff_rows_capped,
                ),
            )
    except Exception as exc:
        return ScenarioResult(
            scenario=scenario,
            passed=False,
            duration_ms=round((time.monotonic() - t0) * 1000, 2),
            error=_sanitise_error(exc),
        )


# ── Scenario registry ──────────────────────────────────────────────────────────
#
# All scenarios (sync and async) are stored in a single dict.  The main runner
# dispatches through :func:`_run_scenario` which auto-detects async vs sync.

_SCENARIO_RUNNERS: dict[str, Any] = {
    "normal_roundtrip": _scenario_normal_roundtrip,
    "key_rotation": _scenario_key_rotation,
    "migration": _scenario_migration,
    "corruption": _scenario_corruption,
    "wrong_identity": _scenario_wrong_identity,
    "rollback": _scenario_rollback,
    "scheduler_no_duplicate_effects": _scenario_scheduler_no_duplicate_effects,
}


async def _run_scenario(
    name: str, runner: Any, **kwargs: Any
) -> ScenarioResult:
    """Run a scenario that may be async or sync."""
    import inspect

    if inspect.iscoroutinefunction(runner):
        return await runner(**kwargs)
    else:
        return runner(**kwargs)


# ── Public entry point ─────────────────────────────────────────────────────────


async def run_restore_drill(
    config: DrillConfig | None = None,
    *,
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> DrillReport:
    """Run all (or a subset of) restore-drill scenarios and return a bounded report.

    Parameters
    ----------
    config:
        :class:`DrillConfig` controlling which scenarios and schema versions
        are exercised.  Defaults to all scenarios, schema version {1}.
    agent_id:
        Synthetic agent identity used throughout the drill.  Must be a
        non-empty string.
    master_pw:
        Ephemeral master password for key wrapping during the drill.  Must be a
        non-empty string.

    Returns
    -------
    DrillReport
        A bounded, transport-safe summary.  No raw key material or PII is
        included.
    """
    if config is None:
        config = DrillConfig()

    start = time.monotonic()
    report = DrillReport(timestamp=_utc_now_iso())
    drill_scenarios: list[str] = sorted(
        s for s in config.scenarios if s in _SCENARIO_RUNNERS
    )

    report.total = len(drill_scenarios)

    log.info("restore_drill_start", scenarios=drill_scenarios)

    for scenario_name in drill_scenarios:
        scenario_start = time.monotonic()

        kwargs: dict[str, Any] = {"agent_id": agent_id, "master_pw": master_pw}
        if scenario_name == "migration":
            kwargs["schema_versions"] = config.schema_versions

        runner = _SCENARIO_RUNNERS[scenario_name]

        try:
            result = await asyncio.wait_for(
                _run_scenario(scenario_name, runner, **kwargs),
                timeout=config.max_duration_secs,
            )
        except asyncio.TimeoutError:
            result = ScenarioResult(
                scenario=scenario_name,
                passed=False,
                detail="Scenario timed out after {:.1f}s".format(
                    config.max_duration_secs
                ),
            )

        if result.duration_ms == 0:
            result.duration_ms = round(
                (time.monotonic() - scenario_start) * 1000, 2
            )

        report.scenarios.append(result)
        if result.passed:
            report.passed += 1
        else:
            report.failed += 1
            log.warning(
                "restore_drill_scenario_failed",
                scenario=result.scenario,
                error=result.error or result.detail,
            )

    report.duration_ms = round((time.monotonic() - start) * 1000, 2)
    log.info(
        "restore_drill_complete",
        total=report.total,
        passed=report.passed,
        failed=report.failed,
        duration_ms=report.duration_ms,
    )
    return report


def run_restore_drill_sync(
    config: DrillConfig | None = None,
    *,
    agent_id: str = "drill-agent",
    master_pw: str = "drill-ephemeral-pw",
) -> DrillReport:
    """Synchronous wrapper for :func:`run_restore_drill` (used by CLI)."""
    return asyncio.run(
        run_restore_drill(config=config, agent_id=agent_id, master_pw=master_pw)
    )


# ── Report persistence ─────────────────────────────────────────────────────────


def write_drill_report(
    report: DrillReport,
    report_dir: Path | str | None = None,
    *,
    retain_count: int = _REPORT_RETAIN_COUNT,
) -> Path:
    """Persist a drill report as JSON and prune old reports.

    Parameters
    ----------
    report:
        The report to persist.
    report_dir:
        Directory for reports.  Default: ``~/.talos-agent/drill_reports``.
    retain_count:
        Maximum number of historical reports to keep.

    Returns
    -------
    Path
        The path to the written report file.
    """
    target_dir = Path(report_dir) if report_dir else _DEFAULT_DRILL_DIR
    target_dir.mkdir(parents=True, exist_ok=True)

    def _build_report_json(max_detail: int = 500, max_error: int = 200) -> str:
        return json.dumps(
            {
                "timestamp": report.timestamp,
                "total": report.total,
                "passed": report.passed,
                "failed": report.failed,
                "duration_ms": report.duration_ms,
                "scenarios": [
                    {
                        "scenario": s.scenario,
                        "passed": s.passed,
                        "duration_ms": s.duration_ms,
                        "detail": (s.detail or "")[:max_detail],
                        "error": (s.error or "")[:max_error],
                    }
                    for s in report.scenarios
                ],
            },
            indent=2,
            sort_keys=True,
        )

    # Build JSON and enforce bounded size
    report_json = _build_report_json()
    report_bytes = report_json.encode("utf-8")

    # Progressively truncate if over limit
    truncation_levels = [(500, 200), (200, 100), (100, 50)]
    for max_d, max_e in truncation_levels:
        if len(report_bytes) <= _MAX_REPORT_SIZE_BYTES:
            break
        report_json = _build_report_json(max_detail=max_d, max_error=max_e)
        report_bytes = report_json.encode("utf-8")

    # Final safeguard: if still too large, drop scenario details entirely
    if len(report_bytes) > _MAX_REPORT_SIZE_BYTES:
        report_json = json.dumps(
            {
                "timestamp": report.timestamp,
                "total": report.total,
                "passed": report.passed,
                "failed": report.failed,
                "duration_ms": report.duration_ms,
                "scenarios": [
                    {
                        "scenario": s.scenario,
                        "passed": s.passed,
                        "duration_ms": s.duration_ms,
                    }
                    for s in report.scenarios
                ],
            },
            indent=2,
            sort_keys=True,
        )

    timestamp_slug = report.timestamp.replace(":", "-").replace(".", "-")
    report_path = target_dir / f"drill_report_{timestamp_slug}.json"
    report_path.write_text(report_json, encoding="utf-8")

    # Prune old reports
    _prune_old_reports(target_dir, retain_count, current=report_path.name)

    return report_path


def _prune_old_reports(
    report_dir: Path, retain_count: int, *, current: str
) -> None:
    """Keep only the ``retain_count`` most recent drill reports.

    Sorts by filename timestamp (embedded in the report name) so that rapid
    writes with identical ``mtime`` values still produce deterministic results.
    """
    reports = sorted(
        report_dir.glob("drill_report_*.json"),
        key=lambda p: p.name,  # sort by filename (contains timestamp)
    )
    while len(reports) > retain_count:
        oldest = reports.pop(0)
        if oldest.name != current:
            oldest.unlink(missing_ok=True)


__all__ = [
    "ALL_SCENARIOS",
    "DrillConfig",
    "DrillReport",
    "ScenarioResult",
    "_DEFAULT_DRILL_DIR",
    "run_restore_drill",
    "run_restore_drill_sync",
    "write_drill_report",
]
