"""JobsRepo — claimed_jobs and completion_markers table access."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone


class JobsRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ── Claimed Jobs ───────────────────────────────────────

    def upsert_claimed_job(
        self,
        job_id: str,
        fencing_token: int,
        ttl_seconds: int = 300,
        lease_expires_at: datetime | None = None,
    ) -> None:
        if not job_id or not isinstance(job_id, str):
            raise ValueError("job_id must be a non-empty string")
        if not isinstance(fencing_token, int) or fencing_token < 0:
            raise ValueError("fencing_token must be a non-negative integer")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")

        expires_iso = (
            lease_expires_at.isoformat()
            if lease_expires_at is not None
            else (datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)).isoformat()
        )
        self._conn.execute(
            """INSERT INTO claimed_jobs (job_id, fencing_token, lease_expires_at, ttl_seconds)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET
                   fencing_token   = excluded.fencing_token,
                   lease_expires_at = excluded.lease_expires_at,
                   ttl_seconds     = excluded.ttl_seconds""",
            (job_id, fencing_token, expires_iso, ttl_seconds),
        )
        self._conn.commit()

    def get_claimed_job(self, job_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT job_id, fencing_token, claimed_at, lease_expires_at, ttl_seconds "
            "FROM claimed_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "job_id": row["job_id"],
            "fencing_token": int(row["fencing_token"]),
            "claimed_at": datetime.fromisoformat(row["claimed_at"]),
            "lease_expires_at": (
                datetime.fromisoformat(row["lease_expires_at"])
                if row["lease_expires_at"] else None
            ),
            "ttl_seconds": int(row["ttl_seconds"]),
        }

    def get_all_claimed_jobs(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT job_id, fencing_token, claimed_at, lease_expires_at, ttl_seconds "
            "FROM claimed_jobs"
        ).fetchall()
        return [
            {
                "job_id": r["job_id"],
                "fencing_token": int(r["fencing_token"]),
                "claimed_at": datetime.fromisoformat(r["claimed_at"]),
                "lease_expires_at": (
                    datetime.fromisoformat(r["lease_expires_at"])
                    if r["lease_expires_at"] else None
                ),
                "ttl_seconds": int(r["ttl_seconds"]),
            }
            for r in rows
        ]

    def delete_claimed_job(self, job_id: str) -> None:
        self._conn.execute("DELETE FROM claimed_jobs WHERE job_id = ?", (job_id,))
        self._conn.commit()

    # ── Completion Markers ─────────────────────────────────

    def add_completion_marker(
        self,
        job_id: str,
        idempotency_key: str,
        retain_days: int = 7,
    ) -> None:
        if not job_id or not isinstance(job_id, str):
            raise ValueError("job_id must be a non-empty string")
        if not idempotency_key or not isinstance(idempotency_key, str):
            raise ValueError("idempotency_key must be a non-empty string")
        if retain_days <= 0:
            raise ValueError("retain_days must be positive")

        expires_at = (
            datetime.now(timezone.utc) + timedelta(days=retain_days)
        ).isoformat()
        self._conn.execute(
            "INSERT INTO completion_markers (job_id, idempotency_key, expires_at) "
            "VALUES (?, ?, ?)",
            (job_id, idempotency_key, expires_at),
        )
        self._conn.commit()

    def has_completion_marker(self, idempotency_key: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM completion_markers "
            "WHERE idempotency_key = ? AND expires_at > datetime('now')",
            (idempotency_key,),
        ).fetchone()
        return row is not None

    def get_completion_markers_for_job(self, job_id: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, job_id, idempotency_key, completed_at, expires_at "
            "FROM completion_markers "
            "WHERE job_id = ? AND expires_at > datetime('now') "
            "ORDER BY completed_at DESC",
            (job_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def prune_expired_completion_markers(self) -> int:
        rows = self._conn.execute(
            "SELECT id, expires_at FROM completion_markers"
        ).fetchall()
        expired_ids: list[int] = []
        now = datetime.now(timezone.utc)

        for row in rows:
            expires_at = row["expires_at"]
            if not expires_at:
                continue
            try:
                expires_dt = datetime.fromisoformat(expires_at)
                if expires_dt.tzinfo is None:
                    expires_dt = expires_dt.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                continue
            if expires_dt <= now:
                expired_ids.append(int(row["id"]))

        if expired_ids:
            self._conn.executemany(
                "DELETE FROM completion_markers WHERE id = ?",
                [(mid,) for mid in expired_ids],
            )
            self._conn.commit()
        return len(expired_ids)
