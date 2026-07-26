"""Post-checkpoint-restore reconciliation for the Talos agent.

Problem
-------
After a crash-restore or process restart the agent's in-memory state is gone.
The SQLite database persists schedules, backoff state, and (after this fix)
claimed job fencing tokens.  But that persisted state may be *stale*:

* ``retry_state.next_attempt_at`` could be hours in the future if the clock
  was skewed or the agent crashed mid-backoff.
* ``schedules.last_run_at`` could be far in the past (missed runs) or
  impossibly far in the future (clock skew).
* ``claimed_jobs`` rows might refer to leases that have already expired on
  the server, or that another worker has since claimed.
* ``completion_markers`` rows for already-expired entries should be pruned to
  keep idempotency lookups fast.

This module provides :func:`reconcile_after_restore` — a single async
function called at agent startup that performs all of these reconciliation
steps deterministically before the scheduler starts any background tasks.

Reconciliation steps (in order)
---------------------------------
1. **Prune expired completion markers** — fast O(n) DELETE before anything else.
2. **Cap stale backoff timestamps** — any ``next_attempt_at`` beyond
   ``MAX_BACKOFF_FUTURE_SECS`` from now is clamped to ``now + base_delay``.
3. **Validate schedule timestamps** — any ``last_run_at`` that is in the
   *future* by more than ``MAX_CLOCK_SKEW_SECS`` is reset to ``now`` so the
   task does not skip its first post-restore run.
4. **Re-verify claimed jobs against the API** — for each persisted
   ``claimed_jobs`` row:
   a. Check whether the lease is still ours via ``api.heartbeat_job``.
   b. If the heartbeat succeeds: restore the fencing token into the in-memory
      ``_claimed_jobs`` dict (commerce module).
   c. If the heartbeat fails (lease lost, expired, or server error): remove
      the row from DB and skip restoring it into memory.
   d. If the API is unreachable: keep the DB row but *do not* populate
      in-memory state — the job_heartbeat_task will rediscover it later once
      connectivity is restored.

Configuration (via ``ReconcileConfig``)
-----------------------------------------
All thresholds are configurable with sensible defaults.  See
:class:`ReconcileConfig` for details.

Observability
--------------
Every action is emitted through ``structlog`` (structured JSON) at ``INFO``
level via ``talos_agent.observability.log``.  A single summary record
``restore_reconciliation_complete`` is emitted at the end with counts of
every action taken.

Errors
------
Individual step failures are logged as warnings and do not abort reconciliation
— the function is designed to be fault-tolerant so a single broken row does
not prevent the agent from starting.

Rollback / migration safety
-----------------------------
This module depends on migration 9 (``claimed_jobs`` and
``completion_markers`` tables).  On a database that predates migration 9,
:meth:`LocalDB._run_migrations` applies the migration automatically on
``LocalDB.__init__``, so no manual action is required.

A fresh agent that has never claimed a job will have an empty
``claimed_jobs`` table; reconciliation will be a no-op in under 1 ms.

Limitations
-----------
* Re-verification requires a live connection to the Talos API.  If the API
  is unreachable on startup, claimed-jobs will not be restored to in-memory
  state in this pass.  The ``job_heartbeat_task`` will attempt heartbeats
  every ``job_heartbeat_interval`` seconds; if the first heartbeat succeeds it
  will call ``set_claimed_job`` which repopulates memory.  This means there is
  a window (up to ``job_heartbeat_interval``) after an offline restore where
  the agent cannot fulfill jobs — this is acceptable because the heartbeat
  itself would fail anyway.
* Clock-skew validation uses the agent's local wall clock.  If the system
  clock is broken, ``MAX_CLOCK_SKEW_SECS`` guards will still fire; the only
  scenario they cannot defend against is a clock that is *consistently* wrong
  by less than ``MAX_CLOCK_SKEW_SECS``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from talos_agent.observability import log

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB

logger = logging.getLogger(__name__)

_CHECKPOINT_TABLES = (
    "schedules",
    "activity_log",
    "content_history",
    "commerce_queue",
    "approval_cache",
    "spending_log",
    "talos_config",
    "playbooks",
    "content_performance",
    "strategy_learnings",
    "audience_insights",
    "loans",
    "loan_repayments",
    "dividends_log",
    "retry_state",
)



# ── Configuration ──────────────────────────────────────────────────────────────

@dataclass
class ReconcileConfig:
    """Thresholds and options for :func:`reconcile_after_restore`.

    Attributes
    ----------
    max_backoff_future_secs:
        Any ``next_attempt_at`` more than this many seconds in the future is
        capped to ``now + backoff_cap_secs``.  Default: 3 600 (1 hour).
    backoff_cap_secs:
        Value to replace a future-skewed ``next_attempt_at`` with after
        capping.  Default: 60 (1 minute) — conservative but quick to recover.
    max_clock_skew_secs:
        Any ``last_run_at`` in the *future* by more than this many seconds is
        reset to ``now`` so the task runs immediately on the first cycle.
        Default: 300 (5 minutes).
    completion_marker_retain_days:
        How long completion markers are kept before expiry.  Must match the
        value used by :meth:`LocalDB.add_completion_marker`.  Default: 7.
    api_verify_leases:
        When ``True`` (default), call ``api.heartbeat_job`` for each claimed
        job to verify ownership.  Set to ``False`` in unit tests or
        offline-only environments where the API is unavailable.
    api_timeout_secs:
        Per-job API timeout during lease verification.  Default: 10.
    """

    max_backoff_future_secs: float = 3_600.0
    backoff_cap_secs: float = 60.0
    max_clock_skew_secs: float = 300.0
    completion_marker_retain_days: int = 7
    api_verify_leases: bool = True
    api_timeout_secs: float = 10.0


_DEFAULT_CONFIG = ReconcileConfig()


# ── Result dataclass ───────────────────────────────────────────────────────────

@dataclass
class ReconcileResult:
    """Summary of actions taken during reconciliation.

    All counts are for this single reconciliation pass only.
    """

    # Completion markers
    markers_pruned: int = 0

    # Backoff state
    backoff_rows_capped: int = 0

    # Schedule timestamps
    schedules_reset: int = 0

    # Claimed jobs
    claimed_jobs_found: int = 0
    claimed_jobs_restored: int = 0   # lease verified ✓ → populated in memory
    claimed_jobs_dropped: int = 0    # lease lost/expired → removed from DB
    claimed_jobs_deferred: int = 0   # API unreachable → kept in DB, not in memory

    # Errors
    errors: list[str] = field(default_factory=list)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _parse_dt(value: str | None) -> datetime | None:
    """Parse an ISO-8601 string (possibly without timezone) into a UTC datetime."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Step 1: prune expired completion markers ───────────────────────────────────

def _prune_completion_markers(db: LocalDB, result: ReconcileResult) -> None:
    """Delete completion markers whose ``expires_at`` is in the past."""
    try:
        count = db.prune_expired_completion_markers()
        result.markers_pruned = count
        if count:
            log.info(
                "restore_prune_completion_markers",
                pruned=count,
            )
    except Exception as exc:  # noqa: BLE001
        msg = f"prune_completion_markers failed: {exc}"
        result.errors.append(msg)
        logger.warning(msg)


# ── Step 2: cap future-skewed backoff timestamps ───────────────────────────────

def _cap_stale_backoff(
    db: LocalDB,
    result: ReconcileResult,
    config: ReconcileConfig,
) -> None:
    """Clamp ``next_attempt_at`` values that are implausibly far in the future.

    A crashed agent may have written a ``next_attempt_at`` many hours away.
    Without capping, every task would wait for that full duration on restart,
    making the agent effectively frozen.

    The cap is ``config.backoff_cap_secs`` seconds from now — enough time for
    transient failures to resolve without locking the agent out for hours.
    """
    now = _now_utc()
    cutoff = now + timedelta(seconds=config.max_backoff_future_secs)
    replacement = now + timedelta(seconds=config.backoff_cap_secs)

    try:
        # Read all retry_state rows and check each one
        rows = db._conn.execute(
            "SELECT task_name, attempt_count, next_attempt_at, terminal "
            "FROM retry_state"
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        msg = f"cap_stale_backoff: failed to read retry_state: {exc}"
        result.errors.append(msg)
        logger.warning(msg)
        return

    for row in rows:
        task_name = row["task_name"]
        next_at_raw = row["next_attempt_at"]
        next_at = _parse_dt(next_at_raw)
        if next_at is None:
            # Corrupt value — reset to now
            try:
                db.upsert_retry_state(
                    task_name,
                    attempt_count=int(row["attempt_count"]),
                    next_attempt_at=now,
                    terminal=bool(row["terminal"]),
                )
                result.backoff_rows_capped += 1
                log.info(
                    "restore_backoff_capped_corrupt",
                    task=task_name,
                    raw_value=str(next_at_raw)[:64],
                )
            except Exception as exc:  # noqa: BLE001
                msg = f"cap_stale_backoff: failed to reset corrupt row for {task_name!r}: {exc}"
                result.errors.append(msg)
                logger.warning(msg)
            continue

        if next_at > cutoff:
            original_iso = next_at.isoformat()
            try:
                db.upsert_retry_state(
                    task_name,
                    attempt_count=int(row["attempt_count"]),
                    next_attempt_at=replacement,
                    terminal=bool(row["terminal"]),
                )
                result.backoff_rows_capped += 1
                log.info(
                    "restore_backoff_capped",
                    task=task_name,
                    original_next_at=original_iso,
                    capped_to=replacement.isoformat(),
                    skew_secs=round((next_at - now).total_seconds()),
                )
            except Exception as exc:  # noqa: BLE001
                msg = (
                    f"cap_stale_backoff: failed to cap row for {task_name!r}: {exc}"
                )
                result.errors.append(msg)
                logger.warning(msg)


# ── Step 3: validate schedule timestamps for clock skew ───────────────────────

def _validate_schedule_timestamps(
    db: LocalDB,
    result: ReconcileResult,
    config: ReconcileConfig,
) -> None:
    """Reset any ``last_run_at`` that is impossibly in the future.

    A future ``last_run_at`` causes every task to skip its first post-restore
    run (it looks like it already ran recently).  This step detects that and
    resets the timestamp to now, ensuring tasks run on their normal interval
    after startup.
    """
    now = _now_utc()
    # A schedule timestamp is "impossible future" if it's more than
    # max_clock_skew_secs ahead of the current wall clock.
    skew_limit = now + timedelta(seconds=config.max_clock_skew_secs)

    try:
        rows = db._conn.execute(
            "SELECT task_name, last_run_at FROM schedules"
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        msg = f"validate_schedule_timestamps: failed to read schedules: {exc}"
        result.errors.append(msg)
        logger.warning(msg)
        return

    for row in rows:
        task_name = row["task_name"]
        last_run_raw = row["last_run_at"]
        last_run = _parse_dt(last_run_raw)

        if last_run is None:
            # Corrupt — reset
            try:
                db.update_schedule.__func__(db, task_name)  # type: ignore[attr-defined]
                result.schedules_reset += 1
                log.info(
                    "restore_schedule_reset_corrupt",
                    task=task_name,
                    raw_value=str(last_run_raw)[:64],
                )
            except Exception as exc:  # noqa: BLE001
                msg = (
                    f"validate_schedule_timestamps: failed to reset corrupt schedule "
                    f"for {task_name!r}: {exc}"
                )
                result.errors.append(msg)
                logger.warning(msg)
            continue

        if last_run > skew_limit:
            original_iso = last_run.isoformat()
            try:
                # Reset to now so the task fires on its normal next interval
                db._conn.execute(
                    "UPDATE schedules SET last_run_at = ? WHERE task_name = ?",
                    (now.isoformat(), task_name),
                )
                db._conn.commit()
                result.schedules_reset += 1
                log.info(
                    "restore_schedule_reset_skewed",
                    task=task_name,
                    original_last_run_at=original_iso,
                    reset_to=now.isoformat(),
                    skew_secs=round((last_run - now).total_seconds()),
                )
            except Exception as exc:  # noqa: BLE001
                msg = (
                    f"validate_schedule_timestamps: failed to reset skewed schedule "
                    f"for {task_name!r}: {exc}"
                )
                result.errors.append(msg)
                logger.warning(msg)


# ── Step 4: re-verify claimed jobs against authoritative API ───────────────────

async def _verify_claimed_jobs(
    db: LocalDB,
    api: TalosAPIClient | None,
    result: ReconcileResult,
    config: ReconcileConfig,
) -> None:
    """Re-verify each persisted claimed job and repopulate in-memory state.

    For each row in ``claimed_jobs``:

    * If ``api`` is ``None`` or ``api_verify_leases`` is ``False``:
      restore the fencing token into memory unconditionally (useful for
      offline testing).
    * Otherwise call ``api.heartbeat_job(job_id, fencing_token)``:
      - Success: restore to memory.
      - Failure (any exception or falsy return): remove from DB and log.
      - Timeout/network error: keep in DB, skip memory restore (deferred).
    """
    from talos_agent.tools import commerce  # local import to avoid circular deps

    try:
        claimed_rows = db.get_all_claimed_jobs()
    except Exception as exc:  # noqa: BLE001
        msg = f"verify_claimed_jobs: failed to read claimed_jobs: {exc}"
        result.errors.append(msg)
        logger.warning(msg)
        return

    result.claimed_jobs_found = len(claimed_rows)
    if not claimed_rows:
        return

    now = _now_utc()

    for row in claimed_rows:
        job_id = row["job_id"]
        fencing_token = row["fencing_token"]
        lease_expires_at = row.get("lease_expires_at")

        # ── Offline or verify-disabled: restore unconditionally ──────────
        if not config.api_verify_leases or api is None:
            commerce._claimed_jobs[job_id] = fencing_token
            result.claimed_jobs_restored += 1
            log.info(
                "restore_job_restored_offline",
                job_id=job_id,
                fencing_token=fencing_token,
            )
            continue

        # ── Check whether the lease has already expired locally ───────────
        # (Avoids an unnecessary API round-trip for obviously-expired leases.)
        if lease_expires_at is not None and lease_expires_at < now:
            log.info(
                "restore_job_dropped_expired",
                job_id=job_id,
                fencing_token=fencing_token,
                lease_expires_at=lease_expires_at.isoformat(),
            )
            try:
                db.delete_claimed_job(job_id)
            except Exception as exc:  # noqa: BLE001
                msg = f"verify_claimed_jobs: failed to delete expired job {job_id!r}: {exc}"
                result.errors.append(msg)
                logger.warning(msg)
            result.claimed_jobs_dropped += 1
            continue

        # ── Verify via API heartbeat ───────────────────────────────────────
        try:
            import asyncio
            heartbeat_ok = await asyncio.wait_for(
                api.heartbeat_job(job_id, fencing_token),
                timeout=config.api_timeout_secs,
            )
            if heartbeat_ok:
                commerce._claimed_jobs[job_id] = fencing_token
                result.claimed_jobs_restored += 1
                log.info(
                    "restore_job_restored",
                    job_id=job_id,
                    fencing_token=fencing_token,
                )
            else:
                # Server rejected our heartbeat — lease no longer ours
                log.info(
                    "restore_job_dropped_lost",
                    job_id=job_id,
                    fencing_token=fencing_token,
                )
                try:
                    db.delete_claimed_job(job_id)
                except Exception as exc:  # noqa: BLE001
                    msg = f"verify_claimed_jobs: failed to delete lost job {job_id!r}: {exc}"
                    result.errors.append(msg)
                    logger.warning(msg)
                result.claimed_jobs_dropped += 1
        except asyncio.TimeoutError:
            # API slow/unreachable — keep DB row, skip memory restore
            result.claimed_jobs_deferred += 1
            log.warning(
                "restore_job_deferred_timeout",
                job_id=job_id,
                timeout_secs=config.api_timeout_secs,
            )
        except Exception as exc:  # noqa: BLE001
            # Unexpected error — treat as API unavailable, defer
            result.claimed_jobs_deferred += 1
            msg = (
                f"verify_claimed_jobs: unexpected error verifying job {job_id!r}: {exc}"
            )
            result.errors.append(msg)
            log.warning(
                "restore_job_deferred_error",
                job_id=job_id,
                error=str(exc),
            )


# ── Public entry point ─────────────────────────────────────────────────────────

async def reconcile_after_restore(
    db: LocalDB,
    api: TalosAPIClient | None = None,
    *,
    config: ReconcileConfig | None = None,
) -> ReconcileResult:
    """Reconcile agent state after a crash-restore or process restart.

    This function **must** be called before any scheduler tasks are started.
    It is idempotent — calling it multiple times is safe (each call re-reads
    the DB and re-verifies leases, but will be a near-no-op if state is
    already clean).

    Parameters
    ----------
    db:
        The open :class:`~talos_agent.db.LocalDB` instance for this agent.
    api:
        Optional :class:`~talos_agent.api_client.TalosAPIClient`.  When
        ``None`` or when ``config.api_verify_leases`` is ``False``, lease
        verification is skipped and all fencing tokens are restored
        unconditionally (useful for offline/unit-test environments).
    config:
        Reconciliation thresholds.  Defaults to :data:`_DEFAULT_CONFIG`.

    Returns
    -------
    ReconcileResult
        A summary of every action taken.  Callers may inspect it for logging
        or assertions.

    Raises
    ------
    This function is designed to be fault-tolerant: individual step failures
    are captured in :attr:`ReconcileResult.errors` and do not propagate.  The
    only exception is a programming error (e.g. passing ``None`` for *db*)
    which will raise ``TypeError`` immediately.
    """
    if db is None:
        raise TypeError("db must not be None")

    if config is None:
        config = _DEFAULT_CONFIG

    result = ReconcileResult()

    log.info("restore_reconciliation_start")

    # Step 1 — prune expired completion markers (fast, no network)
    _prune_completion_markers(db, result)

    # Step 2 — cap future-skewed backoff timestamps (fast, no network)
    _cap_stale_backoff(db, result, config)

    # Step 3 — validate schedule timestamps for clock skew (fast, no network)
    _validate_schedule_timestamps(db, result, config)

    # Step 4 — re-verify claimed jobs against authoritative API (async, network)
    await _verify_claimed_jobs(db, api, result, config)

    log.info(
        "restore_reconciliation_complete",
        markers_pruned=result.markers_pruned,
        backoff_rows_capped=result.backoff_rows_capped,
        schedules_reset=result.schedules_reset,
        claimed_jobs_found=result.claimed_jobs_found,
        claimed_jobs_restored=result.claimed_jobs_restored,
        claimed_jobs_dropped=result.claimed_jobs_dropped,
        claimed_jobs_deferred=result.claimed_jobs_deferred,
        errors=len(result.errors),
    )

    if result.errors:
        logger.warning(
            "restore_reconciliation finished with %d error(s): %s",
            len(result.errors),
            "; ".join(result.errors),
        )

    return result


# ── Transactional Staged Checkpoint Restore ────────────────────────────────────

class StagedRestoreError(Exception):
    """Base class for transactional staged restore errors."""


class PreflightError(StagedRestoreError):
    """Raised when preflight validation or authorization fails before staging."""


class StagingError(StagedRestoreError):
    """Raised when staging or applying migrations against staged state fails."""


class InvariantError(StagedRestoreError):
    """Raised when staged database invariant checks fail."""


class RollbackError(StagedRestoreError):
    """Raised when commit fails and active state was rolled back to prior backup."""


@dataclass
class StagedRestoreConfig:
    """Configuration options for transactional staged restore.

    Attributes
    ----------
    max_size_bytes:
        Maximum allowed size for checkpoint files in bytes. Default: 10MB.
    allowed_schema_versions:
        Set of supported schema versions. Default: {1}.
    require_agent_match:
        If True, requires checkpoint payload agent_id to match expected agent_id.
    backup_retain_count:
        Number of historical active database backups to retain. Default: 3.
    run_migrations:
        If True, runs database migrations against staged state. Default: True.
    verify_invariants:
        If True, runs structural & data invariant checks on staged state. Default: True.
    master_password:
        Optional master password for unwrap operation if checkpoint is encrypted envelope.
    api_verify_leases:
        Whether post-restore lease verification calls live API. Default: False.
    staging_dir:
        Directory for temporary staged database files. Default: target database directory.
    """

    max_size_bytes: int = 10 * 1024 * 1024
    allowed_schema_versions: set[int] = field(default_factory=lambda: {1})
    require_agent_match: bool = True
    backup_retain_count: int = 3
    run_migrations: bool = True
    verify_invariants: bool = True
    master_password: str | None = None
    api_verify_leases: bool = False
    staging_dir: Path | str | None = None


@dataclass
class StagedRestoreResult:
    """Summary of transactional staged restore execution.

    Attributes
    ----------
    agent_id:
        The target agent identifier.
    schema_version:
        The schema version of the restored checkpoint.
    tables_restored:
        Dictionary mapping table names to restored row counts.
    staged_path:
        Path to the temporary staged database file used during restore.
    backup_path:
        Path to the backup created before atomic commit, if any.
    preflight_passed:
        True if preflight checks passed cleanly.
    invariants_passed:
        True if staged invariant verification passed.
    committed:
        True if atomic commit replaced active state successfully.
    rolled_back:
        True if a failure during commit triggered an automatic rollback.
    reconciliation_result:
        Optional summary of post-restore state reconciliation.
    duration_ms:
        Total duration of the restore operation in milliseconds.
    errors:
        List of non-fatal warnings or error messages collected.
    """

    agent_id: str
    schema_version: int = 1
    tables_restored: dict[str, int] = field(default_factory=dict)
    staged_path: str = ""
    backup_path: str | None = None
    preflight_passed: bool = False
    invariants_passed: bool = False
    committed: bool = False
    rolled_back: bool = False
    reconciliation_result: ReconcileResult | None = None
    duration_ms: float = 0.0
    errors: list[str] = field(default_factory=list)


class StagedRestoreManager:
    """Manages transactional staged restores through preflight, staging, invariants, atomic commit, and rollback."""

    def __init__(self, config: StagedRestoreConfig | None = None) -> None:
        self.config = config or StagedRestoreConfig()

    async def perform_staged_restore(
        self,
        target_db_path: Path | str,
        checkpoint_input: dict[str, Any] | Path | str,
        agent_id: str,
        *,
        api: TalosAPIClient | None = None,
    ) -> StagedRestoreResult:
        """Perform transactional staged restore end-to-end.

        Steps:
        1. Preflight validation (active state remains unchanged).
        2. Staging & migrations (runs against staged state only).
        3. Invariants verification (checks staged database integrity).
        4. Atomic commit & bounded rollback (preserves prior state, atomic swap, post-restore reconciliation).
        """
        start_time = time.monotonic()
        target_path = Path(target_db_path).resolve()
        result = StagedRestoreResult(
            agent_id=agent_id,
            schema_version=1,
            tables_restored={},
            staged_path="",
        )

        log.info(
            "restore_staged_start",
            agent_id=agent_id,
            target_db=str(target_path),
        )

        # Step 1: Preflight Check
        payload = self._preflight_check(checkpoint_input, agent_id, result)
        result.preflight_passed = True
        log.info("restore_staged_preflight_passed", agent_id=agent_id)

        # Step 2: Staging & Migrations
        staged_path = self._stage_checkpoint(target_path, payload, agent_id, result)
        result.staged_path = str(staged_path)

        # Step 3: Invariants Verification
        if self.config.verify_invariants:
            self._verify_invariants(staged_path, agent_id, result)
            result.invariants_passed = True
            log.info("restore_staged_invariants_passed", agent_id=agent_id)

        # Step 4: Atomic Commit & Bounded Rollback
        await self._commit_and_reconcile(
            target_path=target_path,
            staged_path=staged_path,
            agent_id=agent_id,
            api=api,
            result=result,
        )

        result.duration_ms = round((time.monotonic() - start_time) * 1000, 2)
        log.info(
            "restore_staged_complete",
            agent_id=agent_id,
            duration_ms=result.duration_ms,
            committed=result.committed,
        )
        return result

    def _preflight_check(
        self,
        checkpoint_input: dict[str, Any] | Path | str,
        expected_agent_id: str,
        result: StagedRestoreResult,
    ) -> dict[str, Any]:
        """Validate checkpoint format, bounds, schema compatibility, and identity before touching state."""
        if not expected_agent_id or not isinstance(expected_agent_id, str):
            raise PreflightError("Agent ID must be a non-empty string")

        payload: dict[str, Any] | None = None

        if isinstance(checkpoint_input, (str, Path)):
            input_path = Path(checkpoint_input)
            if not input_path.exists():
                raise PreflightError(f"Checkpoint file not found: {input_path}")

            size = input_path.stat().st_size
            if size > self.config.max_size_bytes:
                raise PreflightError(
                    f"Checkpoint size ({size} bytes) exceeds limit ({self.config.max_size_bytes} bytes)"
                )

            try:
                raw_data = input_path.read_bytes()
                payload = json.loads(raw_data.decode("utf-8"))
            except Exception as exc:
                raise PreflightError(f"Failed to parse checkpoint JSON: {exc}") from exc
        elif isinstance(checkpoint_input, dict):
            payload = checkpoint_input
        else:
            raise PreflightError("Invalid checkpoint input type")

        if not isinstance(payload, dict):
            raise PreflightError("Checkpoint payload must be a JSON object")

        schema_ver = payload.get("schema_version", payload.get("schema", 1))
        if isinstance(schema_ver, bool) or not isinstance(schema_ver, int):
            raise PreflightError("Checkpoint schema_version must be an integer")

        if schema_ver not in self.config.allowed_schema_versions:
            raise PreflightError(
                f"Unsupported checkpoint schema version: {schema_ver}. Allowed: {self.config.allowed_schema_versions}"
            )
        result.schema_version = schema_ver

        payload_agent_id = payload.get("agent_id")
        if payload_agent_id is not None:
            if not isinstance(payload_agent_id, str):
                raise PreflightError("Checkpoint agent_id must be a string")
            if self.config.require_agent_match and payload_agent_id != expected_agent_id:
                raise PreflightError(
                    f"Checkpoint agent_id ({payload_agent_id!r}) does not match expected ({expected_agent_id!r})"
                )

        tables = payload.get("tables")
        if tables is not None:
            if not isinstance(tables, dict):
                raise PreflightError("Checkpoint tables must be an object")
            for table_name, count in tables.items():
                if not isinstance(table_name, str):
                    raise PreflightError("Table names must be strings")
                if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                    raise PreflightError(f"Row count for table {table_name!r} must be a non-negative integer")
                result.tables_restored[table_name] = count

        return payload

    def _stage_checkpoint(
        self,
        target_path: Path,
        payload: dict[str, Any],
        agent_id: str,
        result: StagedRestoreResult,
    ) -> Path:
        """Create staged database and apply migrations against staged state only."""
        target_dir = target_path.parent
        target_dir.mkdir(parents=True, exist_ok=True)

        staging_dir = Path(self.config.staging_dir) if self.config.staging_dir else target_dir
        staged_path = staging_dir / f"{target_path.name}.staged.{secrets.token_hex(8)}.db"

        try:
            from talos_agent.db import LocalDB

            # LocalDB init automatically runs migrations against the staged database
            staged_db = LocalDB(path=staged_path)

            tables_data = payload.get("tables_data", {})
            if isinstance(tables_data, dict) and tables_data:
                for table_name, rows in tables_data.items():
                    if isinstance(rows, list):
                        for row in rows:
                            if isinstance(row, dict):
                                cols = list(row.keys())
                                placeholders = ", ".join(["?"] * len(cols))
                                col_names = ", ".join([f'"{c}"' for c in cols])
                                sql = f'INSERT OR REPLACE INTO "{table_name}" ({col_names}) VALUES ({placeholders})'
                                staged_db._conn.execute(sql, list(row.values()))
                        staged_db._conn.commit()

            staged_db._conn.execute(
                "INSERT OR REPLACE INTO talos_config (key, value) VALUES ('agent_id', ?)",
                (agent_id,),
            )
            staged_db._conn.commit()

            staged_counts: dict[str, int] = {}
            for table_name in _CHECKPOINT_TABLES:
                try:
                    cnt = staged_db._conn.execute(f'SELECT COUNT(*) FROM "{table_name}"').fetchone()[0]
                    staged_counts[table_name] = cnt
                except sqlite3.OperationalError:
                    pass

            if staged_counts:
                result.tables_restored.update(staged_counts)

            staged_db.close()
            log.info("restore_staged_staging_completed", staged_path=str(staged_path))
            return staged_path
        except Exception as exc:
            if staged_path.exists():
                staged_path.unlink(missing_ok=True)
            raise StagingError(f"Failed to create staged database: {exc}") from exc

    def _verify_invariants(
        self,
        staged_path: Path,
        expected_agent_id: str,
        result: StagedRestoreResult,
    ) -> None:
        """Verify database structural and data invariants on staged state."""
        try:
            conn = sqlite3.connect(str(staged_path))
            conn.row_factory = sqlite3.Row

            check = conn.execute("PRAGMA quick_check").fetchone()
            if not check or check[0] != "ok":
                raise InvariantError(f"SQLite integrity check failed: {check[0] if check else 'empty'}")

            existing_tables = {
                r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            }
            required_tables = {"schedules", "talos_config", "activity_log"}
            missing = required_tables - existing_tables
            if missing:
                raise InvariantError(f"Staged database missing required tables: {missing}")

            for tbl in existing_tables:
                if not tbl.startswith("sqlite_"):
                    cnt = conn.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0]
                    if cnt < 0:
                        raise InvariantError(f"Negative row count in table {tbl}")

            cfg_row = conn.execute("SELECT value FROM talos_config WHERE key='agent_id'").fetchone()
            if cfg_row and cfg_row["value"] != expected_agent_id:
                raise InvariantError(
                    f"In-database agent_id ({cfg_row['value']!r}) does not match expected ({expected_agent_id!r})"
                )

            conn.close()
        except Exception as exc:
            if staged_path.exists():
                staged_path.unlink(missing_ok=True)
            if isinstance(exc, InvariantError):
                raise
            raise InvariantError(f"Staged database invariant verification failed: {exc}") from exc

    async def _commit_and_reconcile(
        self,
        target_path: Path,
        staged_path: Path,
        agent_id: str,
        api: TalosAPIClient | None,
        result: StagedRestoreResult,
    ) -> None:
        """Perform atomic commit, bounded backup, reconciliation, and rollback if commit fails."""
        journal_path = target_path.parent / f"{target_path.name}.restore_journal.json"
        backup_path: Path | None = None

        try:
            journal_payload = {
                "status": "staging_completed",
                "agent_id": agent_id,
                "staged_path": str(staged_path),
                "target_path": str(target_path),
                "timestamp": _now_utc().isoformat(),
            }
            journal_path.write_text(json.dumps(journal_payload, indent=2))

            if target_path.exists():
                timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
                backup_path = target_path.parent / f"{target_path.name}.backup.{timestamp_str}"
                shutil.copy2(target_path, backup_path)
                result.backup_path = str(backup_path)
                journal_payload["backup_path"] = str(backup_path)
                log.info("restore_staged_backup_created", backup_path=str(backup_path))

                self._prune_old_backups(target_path)

            journal_payload["status"] = "committing"
            journal_path.write_text(json.dumps(journal_payload, indent=2))

            os.replace(staged_path, target_path)

            for ext in ("-wal", "-shm"):
                aux_file = Path(str(target_path) + ext)
                aux_file.unlink(missing_ok=True)

            journal_payload["status"] = "committed"
            journal_path.write_text(json.dumps(journal_payload, indent=2))
            result.committed = True
            log.info("restore_staged_committed", target_path=str(target_path))

            from talos_agent.db import LocalDB

            active_db = LocalDB(path=target_path)
            try:
                reconcile_cfg = ReconcileConfig(api_verify_leases=self.config.api_verify_leases)
                reconcile_res = await reconcile_after_restore(active_db, api=api, config=reconcile_cfg)
                result.reconciliation_result = reconcile_res
                log.info("restore_staged_reconciliation_completed")
            finally:
                active_db.close()

            journal_path.unlink(missing_ok=True)

        except Exception as exc:
            if backup_path and backup_path.exists():
                try:
                    os.replace(backup_path, target_path)
                    result.rolled_back = True
                    journal_payload["status"] = "rolled_back"
                    journal_path.write_text(json.dumps(journal_payload, indent=2))
                    log.warning("restore_staged_rollback_executed", target_path=str(target_path))
                except Exception as rollback_exc:
                    logger.error(f"Failed to rollback active DB: {rollback_exc}")

            if staged_path.exists():
                staged_path.unlink(missing_ok=True)

            raise RollbackError(f"Restore commit failed and active state was rolled back: {exc}") from exc

    def _prune_old_backups(self, target_path: Path) -> None:
        """Prune old database backups beyond backup_retain_count."""
        pattern = f"{target_path.name}.backup.*"
        backups = sorted(target_path.parent.glob(pattern), key=lambda p: p.stat().st_mtime)
        while len(backups) > self.config.backup_retain_count:
            oldest = backups.pop(0)
            oldest.unlink(missing_ok=True)


async def perform_staged_restore(
    target_db_path: Path | str,
    checkpoint_input: dict[str, Any] | Path | str,
    agent_id: str,
    *,
    config: StagedRestoreConfig | None = None,
    api: TalosAPIClient | None = None,
) -> StagedRestoreResult:
    """Async entry point for transactional staged restore."""
    manager = StagedRestoreManager(config=config)
    return await manager.perform_staged_restore(
        target_db_path=target_db_path,
        checkpoint_input=checkpoint_input,
        agent_id=agent_id,
        api=api,
    )


def perform_staged_restore_sync(
    target_db_path: Path | str,
    checkpoint_input: dict[str, Any] | Path | str,
    agent_id: str,
    *,
    config: StagedRestoreConfig | None = None,
    api: TalosAPIClient | None = None,
) -> StagedRestoreResult:
    """Synchronous entry point for transactional staged restore (used by CLI)."""
    return asyncio.run(
        perform_staged_restore(
            target_db_path=target_db_path,
            checkpoint_input=checkpoint_input,
            agent_id=agent_id,
            config=config,
            api=api,
        )
    )


def recover_interrupted_restore(target_db_path: Path | str) -> bool:
    """Recover from an interrupted restore process by inspecting the restore journal."""
    target_path = Path(target_db_path).resolve()
    journal_path = target_path.parent / f"{target_path.name}.restore_journal.json"

    if not journal_path.exists():
        return False

    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
        status = journal.get("status")
        backup_path_str = journal.get("backup_path")
        staged_path_str = journal.get("staged_path")

        if staged_path_str:
            Path(staged_path_str).unlink(missing_ok=True)

        if status in ("committing", "staging_completed") and backup_path_str:
            backup_path = Path(backup_path_str)
            if backup_path.exists():
                os.replace(backup_path, target_path)
                log.warning("restore_interrupted_recovered", target_path=str(target_path))

        journal_path.unlink(missing_ok=True)
        return True
    except Exception as exc:
        logger.error(f"Error during interrupted restore recovery: {exc}")
        return False


__all__ = [
    "InvariantError",
    "PreflightError",
    "ReconcileConfig",
    "ReconcileResult",
    "RollbackError",
    "StagedRestoreConfig",
    "StagedRestoreError",
    "StagedRestoreManager",
    "StagedRestoreResult",
    "StagingError",
    "perform_staged_restore",
    "perform_staged_restore_sync",
    "reconcile_after_restore",
    "recover_interrupted_restore",
]

