"""Durable inbox/outbox for provider job completion effects.

The Web API owns the externally visible job state.  This module persists the
local intent before network I/O and reconciles the remote completed state after
ambiguous failures.  Correctness is based on SQLite transactions and remote
fencing, never on process-local locks.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import TYPE_CHECKING, Any

from talos_agent.observability import log

if TYPE_CHECKING:
    from talos_agent.api_client import TalosAPIClient
    from talos_agent.db import LocalDB


_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class JobEffectError(Exception):
    """Base class for safe, operator-facing durable job errors."""

    code = "job_effect_error"


class JobValidationError(JobEffectError):
    code = "validation_error"


class JobAuthorizationError(JobEffectError):
    code = "authorization_error"


class JobConflictError(JobEffectError):
    code = "conflict"


class JobBusyError(JobEffectError):
    code = "busy"


class JobCapacityError(JobEffectError):
    code = "capacity"


class JobStateError(JobEffectError):
    code = "invalid_state"


class InboxState(str, Enum):
    RECEIVED = "received"
    CLAIMED = "claimed"
    EFFECT_PENDING = "effect_pending"
    COMPLETED = "completed"
    CONFLICT = "conflict"


class EffectState(str, Enum):
    PENDING = "pending"
    DISPATCHING = "dispatching"
    SUCCEEDED = "succeeded"
    RETRYABLE = "retryable"
    INDETERMINATE = "indeterminate"
    CONFLICT = "conflict"
    DEAD = "dead"


@dataclass(frozen=True)
class JobEffectLimits:
    max_inbox_records: int = 100_000
    max_outbox_records: int = 100_000
    max_payload_bytes: int = 65_536
    max_result_bytes: int = 262_144
    batch_size: int = 20
    lease_seconds: int = 30
    max_attempts: int = 8
    retry_base_seconds: int = 2
    dispatch_timeout_seconds: int = 20
    remote_lease_ttl_seconds: int = 300
    busy_timeout_ms: int = 5_000


@dataclass(frozen=True)
class InboxRecord:
    job_id: str
    state: InboxState
    payload_digest: str
    fencing_token: int | None


@dataclass(frozen=True)
class EffectRecord:
    effect_id: str
    job_id: str
    state: EffectState
    result: dict[str, Any]
    result_digest: str
    fencing_token: int
    attempt_count: int
    lease_owner: str


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _validate_identifier(value: object, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER_RE.fullmatch(value):
        raise JobValidationError(f"{label} must be a valid bounded identifier")
    return value


def _canonical_json(value: object, *, max_bytes: int, label: str) -> tuple[str, str]:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise JobValidationError(f"{label} must be JSON-compatible") from exc
    raw = encoded.encode("utf-8")
    if len(raw) > max_bytes:
        raise JobValidationError(f"{label} exceeds the configured byte limit")
    return encoded, hashlib.sha256(raw).hexdigest()


def _validate_text(value: object, label: str, *, max_bytes: int) -> str:
    if not isinstance(value, str):
        raise JobValidationError(f"{label} must be a string")
    if len(value.encode("utf-8")) > max_bytes:
        raise JobValidationError(f"{label} exceeds the configured byte limit")
    if any(ord(char) < 32 for char in value):
        raise JobValidationError(f"{label} contains invalid control characters")
    return value


def _decode_object(encoded: str, label: str) -> dict[str, Any]:
    value = json.loads(encoded)
    if not isinstance(value, dict):
        raise JobStateError(f"stored {label} is not an object")
    return value


class JobEffectStore:
    """Transactional durable job state scoped to one Talos identity."""

    def __init__(
        self,
        db: LocalDB,
        *,
        owner_talos_id: str,
        limits: JobEffectLimits | None = None,
    ):
        self._db = db
        self.owner_talos_id = _validate_identifier(owner_talos_id, "Talos ID")
        self.limits = limits or JobEffectLimits()
        numeric_bounds = {
            "max_inbox_records": (self.limits.max_inbox_records, 1, 1_000_000),
            "max_outbox_records": (self.limits.max_outbox_records, 1, 1_000_000),
            "max_payload_bytes": (self.limits.max_payload_bytes, 1, 1_048_576),
            "max_result_bytes": (self.limits.max_result_bytes, 1, 2_097_152),
            "batch_size": (self.limits.batch_size, 1, 200),
            "lease_seconds": (self.limits.lease_seconds, 1, 900),
            "max_attempts": (self.limits.max_attempts, 1, 100),
            "retry_base_seconds": (self.limits.retry_base_seconds, 1, 300),
            "dispatch_timeout_seconds": (
                self.limits.dispatch_timeout_seconds,
                1,
                120,
            ),
            "remote_lease_ttl_seconds": (
                self.limits.remote_lease_ttl_seconds,
                1,
                3_600,
            ),
            "busy_timeout_ms": (self.limits.busy_timeout_ms, 1, 30_000),
        }
        for label, (value, minimum, maximum) in numeric_bounds.items():
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value < minimum
                or value > maximum
            ):
                raise JobValidationError(f"{label} is outside the supported range")
        self._conn.execute(f"PRAGMA busy_timeout = {self.limits.busy_timeout_ms}")
        self._conn.execute("PRAGMA synchronous = FULL")
        self._conn.execute("PRAGMA foreign_keys = ON")

    @property
    def _conn(self) -> sqlite3.Connection:
        return self._db._conn

    def _begin(self) -> None:
        try:
            self._conn.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            if "locked" in str(exc).lower() or "busy" in str(exc).lower():
                raise JobBusyError("durable job store is busy; retry later") from exc
            raise

    def _capacity(self, table: str, limit: int) -> None:
        count = self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if count >= limit:
            log.warning(
                "job_effect_capacity_rejected",
                table=table,
                limit=limit,
                talos_id=self.owner_talos_id,
            )
            raise JobCapacityError(f"{table} reached its configured record limit")

    def ingest(self, job: dict[str, Any]) -> InboxRecord:
        job_id = _validate_identifier(job.get("id"), "job ID")
        owner = _validate_identifier(job.get("talosId"), "job Talos ID")
        if owner != self.owner_talos_id:
            raise JobAuthorizationError("job does not belong to this Talos")
        service_type = _validate_text(
            job.get("serviceName") or "",
            "service name",
            max_bytes=200,
        )
        payload_json, payload_digest = _canonical_json(
            job.get("payload"),
            max_bytes=self.limits.max_payload_bytes,
            label="job payload",
        )
        requester = job.get("requesterTalosId")
        if requester is not None:
            requester = _validate_identifier(requester, "requester Talos ID")

        self._begin()
        try:
            row = self._conn.execute(
                """
                SELECT state, payload_digest, fencing_token,
                       requester_talos_id, service_type
                FROM job_inbox
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (self.owner_talos_id, job_id),
            ).fetchone()
            if row:
                if (
                    row["payload_digest"] != payload_digest
                    or row["requester_talos_id"] != requester
                    or row["service_type"] != service_type
                ):
                    raise JobConflictError("job ID was reused with different immutable data")
                self._conn.commit()
                return InboxRecord(
                    job_id=job_id,
                    state=InboxState(row["state"]),
                    payload_digest=payload_digest,
                    fencing_token=row["fencing_token"],
                )

            self._capacity("job_inbox", self.limits.max_inbox_records)
            self._conn.execute(
                """
                INSERT INTO job_inbox (
                    owner_talos_id, job_id, requester_talos_id, service_type,
                    payload_json, payload_digest, state, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    self.owner_talos_id,
                    job_id,
                    requester,
                    service_type,
                    payload_json,
                    payload_digest,
                    InboxState.RECEIVED.value,
                    _iso(_utcnow()),
                ),
            )
            # Preserve the established queue for backward-compatible status and
            # contributor tooling.  Both inserts commit atomically.
            self._conn.execute(
                """
                INSERT OR IGNORE INTO commerce_queue
                    (job_id, talos_id, service_type, payload)
                VALUES (?, ?, ?, ?)
                """,
                (job_id, owner, service_type, payload_json),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

        log.info(
            "job_inbox_transition",
            talos_id=self.owner_talos_id,
            job_id=job_id,
            state=InboxState.RECEIVED.value,
        )
        return InboxRecord(job_id, InboxState.RECEIVED, payload_digest, None)

    def mark_claimed(
        self,
        job_id: str,
        *,
        fencing_token: int,
        lease_expires_at: str | None,
    ) -> InboxRecord:
        job_id = _validate_identifier(job_id, "job ID")
        if not isinstance(fencing_token, int) or isinstance(fencing_token, bool):
            raise JobValidationError("fencing token must be an integer")
        if fencing_token < 1 or fencing_token > 9_223_372_036_854_775_807:
            raise JobValidationError("fencing token is outside the supported range")
        if lease_expires_at is not None:
            if not isinstance(lease_expires_at, str) or len(lease_expires_at) > 64:
                raise JobValidationError("lease expiry is invalid")
            try:
                datetime.fromisoformat(lease_expires_at.replace("Z", "+00:00"))
            except ValueError as exc:
                raise JobValidationError("lease expiry is invalid") from exc

        self._begin()
        try:
            row = self._conn.execute(
                """
                SELECT state, payload_digest, fencing_token
                FROM job_inbox
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (self.owner_talos_id, job_id),
            ).fetchone()
            if not row:
                raise JobStateError("job must be ingested before it can be claimed")
            if row["state"] in (InboxState.COMPLETED.value, InboxState.CONFLICT.value):
                raise JobStateError("terminal job cannot be claimed")
            previous = row["fencing_token"]
            if previous is not None and fencing_token < previous:
                raise JobConflictError("stale fencing token was rejected")
            self._conn.execute(
                """
                UPDATE job_inbox
                SET state = ?, fencing_token = ?, remote_lease_expires_at = ?,
                    updated_at = ?
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (
                    InboxState.CLAIMED.value,
                    fencing_token,
                    lease_expires_at,
                    _iso(_utcnow()),
                    self.owner_talos_id,
                    job_id,
                ),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

        log.info(
            "job_inbox_transition",
            talos_id=self.owner_talos_id,
            job_id=job_id,
            state=InboxState.CLAIMED.value,
        )
        return InboxRecord(job_id, InboxState.CLAIMED, row["payload_digest"], fencing_token)

    def prepare_effect(self, job_id: str, result: dict[str, Any]) -> str:
        job_id = _validate_identifier(job_id, "job ID")
        if not isinstance(result, dict):
            raise JobValidationError("job result must be an object")
        result_json, result_digest = _canonical_json(
            result,
            max_bytes=self.limits.max_result_bytes,
            label="job result",
        )
        effect_id = hashlib.sha256(
            f"{self.owner_talos_id}:job_result:{job_id}".encode()
        ).hexdigest()
        deduplication_key = f"job-result:{job_id}"

        self._begin()
        try:
            inbox = self._conn.execute(
                """
                SELECT state, fencing_token
                FROM job_inbox
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (self.owner_talos_id, job_id),
            ).fetchone()
            if not inbox or inbox["fencing_token"] is None:
                raise JobStateError("job must have a durable claim before fulfillment")
            existing = self._conn.execute(
                """
                SELECT result_digest, state, fencing_token
                FROM job_effect_outbox
                WHERE effect_id = ? AND owner_talos_id = ?
                """,
                (effect_id, self.owner_talos_id),
            ).fetchone()
            if existing:
                if existing["result_digest"] != result_digest:
                    raise JobConflictError("job effect was reused with a different result")
                if inbox["fencing_token"] > existing["fencing_token"] and existing[
                    "state"
                ] != EffectState.SUCCEEDED.value:
                    self._conn.execute(
                        """
                        UPDATE job_effect_outbox
                        SET fencing_token = ?, updated_at = ?
                        WHERE effect_id = ? AND owner_talos_id = ?
                        """,
                        (
                            inbox["fencing_token"],
                            _iso(_utcnow()),
                            effect_id,
                            self.owner_talos_id,
                        ),
                    )
                self._conn.commit()
                return effect_id

            self._capacity("job_effect_outbox", self.limits.max_outbox_records)
            now = _iso(_utcnow())
            self._conn.execute(
                """
                INSERT INTO job_effect_outbox (
                    effect_id, owner_talos_id, job_id, effect_type,
                    deduplication_key, result_json, result_digest,
                    fencing_token, state, next_attempt_at, updated_at
                ) VALUES (?, ?, ?, 'submit_job_result', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    effect_id,
                    self.owner_talos_id,
                    job_id,
                    deduplication_key,
                    result_json,
                    result_digest,
                    inbox["fencing_token"],
                    EffectState.PENDING.value,
                    now,
                    now,
                ),
            )
            self._conn.execute(
                """
                UPDATE job_inbox
                SET state = ?, updated_at = ?
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (
                    InboxState.EFFECT_PENDING.value,
                    now,
                    self.owner_talos_id,
                    job_id,
                ),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise

        log.info(
            "job_effect_transition",
            talos_id=self.owner_talos_id,
            job_id=job_id,
            effect_id=effect_id,
            state=EffectState.PENDING.value,
            attempt_count=0,
        )
        return effect_id

    def claim_due(self, worker_id: str, limit: int | None = None) -> list[EffectRecord]:
        worker_id = _validate_identifier(worker_id, "worker ID")
        limit = min(limit or self.limits.batch_size, self.limits.batch_size)
        if limit < 1:
            raise JobValidationError("claim limit must be positive")
        now = _utcnow()
        lease_until = _iso(now + timedelta(seconds=self.limits.lease_seconds))

        self._begin()
        try:
            rows = self._conn.execute(
                """
                SELECT effect_id
                FROM job_effect_outbox
                WHERE owner_talos_id = ?
                  AND state IN (?, ?, ?, ?)
                  AND next_attempt_at <= ?
                  AND (lease_until IS NULL OR lease_until <= ?)
                ORDER BY created_at, effect_id
                LIMIT ?
                """,
                (
                    self.owner_talos_id,
                    EffectState.PENDING.value,
                    EffectState.RETRYABLE.value,
                    EffectState.INDETERMINATE.value,
                    EffectState.DISPATCHING.value,
                    _iso(now),
                    _iso(now),
                    limit,
                ),
            ).fetchall()
            claimed: list[EffectRecord] = []
            for selected in rows:
                updated = self._conn.execute(
                    """
                    UPDATE job_effect_outbox
                    SET state = ?, lease_owner = ?, lease_until = ?,
                        attempt_count = attempt_count + 1, updated_at = ?
                    WHERE effect_id = ? AND owner_talos_id = ?
                      AND (lease_until IS NULL OR lease_until <= ?)
                    RETURNING effect_id, job_id, state, result_json,
                              result_digest, fencing_token, attempt_count,
                              lease_owner
                    """,
                    (
                        EffectState.DISPATCHING.value,
                        worker_id,
                        lease_until,
                        _iso(now),
                        selected["effect_id"],
                        self.owner_talos_id,
                        _iso(now),
                    ),
                ).fetchone()
                if updated:
                    claimed.append(
                        EffectRecord(
                            effect_id=updated["effect_id"],
                            job_id=updated["job_id"],
                            state=EffectState(updated["state"]),
                            result=_decode_object(updated["result_json"], "job result"),
                            result_digest=updated["result_digest"],
                            fencing_token=updated["fencing_token"],
                            attempt_count=updated["attempt_count"],
                            lease_owner=updated["lease_owner"],
                        )
                    )
            self._conn.commit()
            return claimed
        except Exception:
            self._conn.rollback()
            raise

    def mark_succeeded(self, effect: EffectRecord, *, reconciled: bool) -> None:
        now = _iso(_utcnow())
        self._begin()
        try:
            updated = self._conn.execute(
                """
                UPDATE job_effect_outbox
                SET state = ?, lease_owner = NULL, lease_until = NULL,
                    last_error_code = NULL, updated_at = ?
                WHERE effect_id = ? AND owner_talos_id = ?
                  AND state = ? AND lease_owner = ?
                """,
                (
                    EffectState.SUCCEEDED.value,
                    now,
                    effect.effect_id,
                    self.owner_talos_id,
                    EffectState.DISPATCHING.value,
                    effect.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise JobConflictError("dispatch lease was lost before completion")
            self._conn.execute(
                """
                UPDATE job_inbox
                SET state = ?, completed_at = ?, updated_at = ?
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (
                    InboxState.COMPLETED.value,
                    now,
                    now,
                    self.owner_talos_id,
                    effect.job_id,
                ),
            )
            self._conn.execute(
                """
                INSERT INTO activity_log (type, content, channel)
                VALUES ('commerce', ?, 'x402')
                """,
                (f"Fulfilled job {effect.job_id}",),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        log.info(
            "job_effect_reconciled" if reconciled else "job_effect_transition",
            talos_id=self.owner_talos_id,
            job_id=effect.job_id,
            effect_id=effect.effect_id,
            state=EffectState.SUCCEEDED.value,
            attempt_count=effect.attempt_count,
        )

    def mark_failure(
        self,
        effect: EffectRecord,
        *,
        error_code: str,
        indeterminate: bool,
    ) -> EffectState:
        if not _ERROR_CODE_RE.fullmatch(error_code):
            raise JobValidationError("error code is invalid")
        if effect.attempt_count >= self.limits.max_attempts:
            state = EffectState.DEAD
        elif indeterminate:
            state = EffectState.INDETERMINATE
        else:
            state = EffectState.RETRYABLE
        delay = min(
            self.limits.retry_base_seconds * (2 ** max(effect.attempt_count - 1, 0)),
            300,
        )
        next_attempt = _iso(_utcnow() + timedelta(seconds=delay))
        self._begin()
        try:
            updated = self._conn.execute(
                """
                UPDATE job_effect_outbox
                SET state = ?, next_attempt_at = ?, lease_owner = NULL,
                    lease_until = NULL, last_error_code = ?, updated_at = ?
                WHERE effect_id = ? AND owner_talos_id = ?
                  AND state = ? AND lease_owner = ?
                """,
                (
                    state.value,
                    next_attempt,
                    error_code,
                    _iso(_utcnow()),
                    effect.effect_id,
                    self.owner_talos_id,
                    EffectState.DISPATCHING.value,
                    effect.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise JobConflictError("dispatch lease was lost before failure handling")
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        log.warning(
            "job_effect_dispatch_failed",
            talos_id=self.owner_talos_id,
            job_id=effect.job_id,
            effect_id=effect.effect_id,
            state=state.value,
            attempt_count=effect.attempt_count,
            error_code=error_code,
        )
        return state

    def mark_conflict(self, effect: EffectRecord) -> None:
        self._begin()
        try:
            updated = self._conn.execute(
                """
                UPDATE job_effect_outbox
                SET state = ?, lease_owner = NULL, lease_until = NULL,
                    last_error_code = 'remote_result_conflict', updated_at = ?
                WHERE effect_id = ? AND owner_talos_id = ?
                  AND state = ? AND lease_owner = ?
                """,
                (
                    EffectState.CONFLICT.value,
                    _iso(_utcnow()),
                    effect.effect_id,
                    self.owner_talos_id,
                    EffectState.DISPATCHING.value,
                    effect.lease_owner,
                ),
            )
            if updated.rowcount != 1:
                raise JobConflictError("dispatch lease was lost before conflict handling")
            self._conn.execute(
                """
                UPDATE job_inbox
                SET state = ?, updated_at = ?
                WHERE owner_talos_id = ? AND job_id = ?
                """,
                (
                    InboxState.CONFLICT.value,
                    _iso(_utcnow()),
                    self.owner_talos_id,
                    effect.job_id,
                ),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        log.error(
            "job_effect_transition",
            talos_id=self.owner_talos_id,
            job_id=effect.job_id,
            effect_id=effect.effect_id,
            state=EffectState.CONFLICT.value,
            attempt_count=effect.attempt_count,
            error_code="remote_result_conflict",
        )

    def claimed_jobs(self) -> dict[str, int]:
        rows = self._conn.execute(
            """
            SELECT inbox.job_id, inbox.fencing_token
            FROM job_inbox AS inbox
            LEFT JOIN job_effect_outbox AS effect
              ON effect.owner_talos_id = inbox.owner_talos_id
             AND effect.job_id = inbox.job_id
            WHERE inbox.owner_talos_id = ?
              AND (
                  inbox.state = ?
                  OR (
                      inbox.state = ?
                      AND effect.state IN (?, ?, ?, ?)
                  )
              )
              AND inbox.fencing_token IS NOT NULL
            """,
            (
                self.owner_talos_id,
                InboxState.CLAIMED.value,
                InboxState.EFFECT_PENDING.value,
                EffectState.PENDING.value,
                EffectState.DISPATCHING.value,
                EffectState.RETRYABLE.value,
                EffectState.INDETERMINATE.value,
            ),
        ).fetchall()
        return {row["job_id"]: row["fencing_token"] for row in rows}

    def pending_jobs(self, *, limit: int = 50) -> list[dict[str, Any]]:
        if limit < 1 or limit > 200:
            raise JobValidationError("pending-job limit must be between 1 and 200")
        rows = self._conn.execute(
            """
            SELECT job_id, service_type, requester_talos_id, payload_json,
                   state, remote_lease_expires_at
            FROM job_inbox
            WHERE owner_talos_id = ?
              AND state IN (?, ?)
            ORDER BY created_at, job_id
            LIMIT ?
            """,
            (
                self.owner_talos_id,
                InboxState.RECEIVED.value,
                InboxState.CLAIMED.value,
                limit,
            ),
        ).fetchall()
        return [
            {
                "job_id": row["job_id"],
                "service": row["service_type"],
                "requester": row["requester_talos_id"],
                "payload": json.loads(row["payload_json"]),
                "state": row["state"],
                "lease_expires_at": row["remote_lease_expires_at"],
            }
            for row in rows
        ]

    def effect_status(self, effect_id: str) -> dict[str, Any]:
        effect_id = _validate_identifier(effect_id, "effect ID")
        row = self._conn.execute(
            """
            SELECT effect_id, job_id, state, attempt_count, next_attempt_at,
                   last_error_code
            FROM job_effect_outbox
            WHERE effect_id = ? AND owner_talos_id = ?
            """,
            (effect_id, self.owner_talos_id),
        ).fetchone()
        if not row:
            raise JobStateError("effect was not found for this Talos")
        return dict(row)

    def inspect(
        self, *, status: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        if limit < 1 or limit > 200:
            raise JobValidationError("inspection limit must be between 1 and 200")
        params: list[object] = [self.owner_talos_id]
        where = "owner_talos_id = ?"
        if status is not None:
            try:
                normalized = EffectState(status).value
            except ValueError as exc:
                raise JobValidationError("unknown effect status") from exc
            where += " AND state = ?"
            params.append(normalized)
        params.append(limit)
        rows = self._conn.execute(
            f"""
            SELECT effect_id, job_id, effect_type, state, attempt_count,
                   next_attempt_at, lease_until, last_error_code, created_at,
                   updated_at
            FROM job_effect_outbox
            WHERE {where}
            ORDER BY created_at DESC, effect_id
            LIMIT ?
            """,
            params,
        ).fetchall()
        return [dict(row) for row in rows]

    def requeue(self, effect_id: str, *, expected_attempt: int) -> dict[str, Any]:
        effect_id = _validate_identifier(effect_id, "effect ID")
        if expected_attempt < 0:
            raise JobValidationError("expected attempt cannot be negative")
        self._begin()
        try:
            row = self._conn.execute(
                """
                SELECT state, attempt_count, job_id
                FROM job_effect_outbox
                WHERE effect_id = ? AND owner_talos_id = ?
                """,
                (effect_id, self.owner_talos_id),
            ).fetchone()
            if not row:
                raise JobStateError("effect was not found for this Talos")
            if row["attempt_count"] != expected_attempt:
                raise JobConflictError("stale expected attempt was rejected")
            if row["state"] == EffectState.PENDING.value:
                self._conn.commit()
                return {
                    "effect_id": effect_id,
                    "job_id": row["job_id"],
                    "state": row["state"],
                    "attempt_count": row["attempt_count"],
                }
            if row["state"] not in {
                EffectState.RETRYABLE.value,
                EffectState.INDETERMINATE.value,
                EffectState.DEAD.value,
            }:
                raise JobStateError("only retryable, indeterminate, or dead effects can be requeued")
            self._conn.execute(
                """
                UPDATE job_effect_outbox
                SET state = ?, next_attempt_at = ?, lease_owner = NULL,
                    lease_until = NULL, last_error_code = NULL, updated_at = ?
                WHERE effect_id = ? AND owner_talos_id = ?
                  AND attempt_count = ?
                """,
                (
                    EffectState.PENDING.value,
                    _iso(_utcnow()),
                    _iso(_utcnow()),
                    effect_id,
                    self.owner_talos_id,
                    expected_attempt,
                ),
            )
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        log.info(
            "job_effect_transition",
            talos_id=self.owner_talos_id,
            job_id=row["job_id"],
            effect_id=effect_id,
            state=EffectState.PENDING.value,
            attempt_count=expected_attempt,
            operator_action="requeue",
        )
        return {
            "effect_id": effect_id,
            "job_id": row["job_id"],
            "state": EffectState.PENDING.value,
            "attempt_count": expected_attempt,
        }


class JobEffectDispatcher:
    """Bounded async dispatcher with remote reconciliation."""

    def __init__(
        self,
        store: JobEffectStore,
        api: TalosAPIClient,
        *,
        worker_id: str | None = None,
    ):
        self.store = store
        self.api = api
        self.worker_id = worker_id or f"worker:{uuid.uuid4()}"

    async def _reconcile(self, effect: EffectRecord) -> EffectState | None:
        remote = await self.api.get_job_result(effect.job_id)
        if not isinstance(remote, dict) or remote.get("status") != "completed":
            return None
        remote_result = remote.get("result")
        if not isinstance(remote_result, dict):
            self.store.mark_conflict(effect)
            return EffectState.CONFLICT
        try:
            _, digest = _canonical_json(
                remote_result,
                max_bytes=self.store.limits.max_result_bytes,
                label="remote job result",
            )
        except JobValidationError:
            self.store.mark_conflict(effect)
            return EffectState.CONFLICT
        if digest == effect.result_digest:
            self.store.mark_succeeded(effect, reconciled=True)
            return EffectState.SUCCEEDED
        else:
            self.store.mark_conflict(effect)
            return EffectState.CONFLICT

    async def _refresh_remote_claim(self, effect: EffectRecord) -> bool:
        claimed = await self.api.claim_job(
            effect.job_id,
            ttl_seconds=self.store.limits.remote_lease_ttl_seconds,
        )
        if not claimed or claimed.get("fencingToken") is None:
            return False
        self.store.mark_claimed(
            effect.job_id,
            fencing_token=claimed["fencingToken"],
            lease_expires_at=claimed.get("leaseExpiresAt"),
        )
        # Idempotently updates the existing effect to the newer fencing token.
        self.store.prepare_effect(effect.job_id, effect.result)
        return True

    async def _dispatch(self, effect: EffectRecord) -> EffectState:
        try:
            reconciled = await self._reconcile(effect)
            if reconciled is not None:
                return reconciled
        except JobEffectError:
            raise
        except Exception:
            # Reconciliation being unavailable is ambiguous, but the remote POST
            # remains safe because completion is fenced and reconcilable.
            pass

        try:
            response = await asyncio.wait_for(
                self.api.submit_job_result(
                    effect.job_id,
                    effect.result,
                    fencing_token=effect.fencing_token,
                    idempotency_key=effect.effect_id,
                ),
                timeout=self.store.limits.dispatch_timeout_seconds,
            )
        except (TimeoutError, asyncio.TimeoutError):
            try:
                reconciled = await self._reconcile(effect)
                if reconciled is not None:
                    return reconciled
            except Exception:
                pass
            return self.store.mark_failure(
                effect,
                error_code="dispatch_timeout",
                indeterminate=True,
            )
        except Exception:
            try:
                reconciled = await self._reconcile(effect)
                if reconciled is not None:
                    return reconciled
            except Exception:
                pass
            return self.store.mark_failure(
                effect,
                error_code="transport_error",
                indeterminate=True,
            )

        if response:
            self.store.mark_succeeded(effect, reconciled=False)
            return EffectState.SUCCEEDED
        try:
            reconciled = await self._reconcile(effect)
            if reconciled is not None:
                return reconciled
        except Exception:
            return self.store.mark_failure(
                effect,
                error_code="reconciliation_unavailable",
                indeterminate=True,
            )
        try:
            refreshed = await self._refresh_remote_claim(effect)
        except Exception:
            refreshed = False
        return self.store.mark_failure(
            effect,
            error_code=(
                "remote_claim_refreshed"
                if refreshed
                else "remote_rejected_or_pending"
            ),
            indeterminate=False,
        )

    async def dispatch_once(self) -> dict[str, int]:
        effects = self.store.claim_due(self.worker_id)
        counts = {state.value: 0 for state in EffectState}
        for effect in effects:
            state = await self._dispatch(effect)
            counts[state.value] += 1
        counts["claimed"] = len(effects)
        return counts
