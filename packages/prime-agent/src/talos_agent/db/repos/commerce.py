"""CommerceRepo — commerce_queue table access."""

from __future__ import annotations

import json
import logging
import sqlite3

COMMERCE_PAYLOAD_RETENTION_DAYS = 30
COMMERCE_PAYLOAD_PRUNE_BATCH_SIZE = 100
logger = logging.getLogger(__name__)


class CommerceRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def add_commerce_job(
        self, job_id: str, talos_id: str, service_type: str, payload: dict | None = None
    ) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO commerce_queue (job_id, talos_id, service_type, payload) VALUES (?, ?, ?, ?)",
            (job_id, talos_id, service_type, json.dumps(payload) if payload else None),
        )
        self._conn.commit()

    def update_commerce_status(self, job_id: str, status: str) -> None:
        self._conn.execute(
            "UPDATE commerce_queue SET status = ?, updated_at = datetime('now'), "
            "payload_retained_until = CASE "
            "WHEN ? = 'completed' AND status != 'completed' "
            "THEN datetime('now', ?) "
            "WHEN ? != 'completed' THEN NULL "
            "ELSE payload_retained_until END WHERE job_id = ?",
            (
                status,
                status,
                f"+{COMMERCE_PAYLOAD_RETENTION_DAYS} days",
                status,
                job_id,
            ),
        )
        self._conn.commit()
        if status == "completed":
            # Completion is a normal lifecycle point. Each pass is bounded so
            # a backlog cannot make a purchase result request unbounded.
            try:
                self.prune_completed_payloads(COMMERCE_PAYLOAD_RETENTION_DAYS)
            except sqlite3.Error:
                # Retention is best-effort; do not turn a recorded purchase
                # completion into an apparent failure if cleanup is delayed.
                logger.warning("Could not prune expired commerce payloads", exc_info=True)

    def prune_completed_payloads(self, retention_days: int = 30) -> int:
        """Remove private fulfillment payloads while retaining financial/job metadata.

        ``spending_log`` remains untouched, so reconciliation records survive
        independently of the private purchased output. The operation is
        idempotent and only clears payloads from completed jobs older than the
        configured window.
        """
        if (
            isinstance(retention_days, bool)
            or not isinstance(retention_days, int)
            or retention_days < 0
        ):
            raise ValueError("retention_days must be a non-negative integer")
        cursor = self._conn.execute(
            "UPDATE commerce_queue SET payload = NULL WHERE id IN ("
            "SELECT id FROM commerce_queue "
            "WHERE status = 'completed' AND payload IS NOT NULL AND ("
            "(payload_retained_until IS NOT NULL AND datetime(payload_retained_until) <= datetime('now')) "
            "OR (payload_retained_until IS NULL AND datetime(updated_at) <= datetime('now', ?))"
            ") ORDER BY COALESCE(payload_retained_until, datetime(updated_at, ?)), id "
            "LIMIT ?) ",
            (
                f"-{retention_days} days",
                f"+{retention_days} days",
                COMMERCE_PAYLOAD_PRUNE_BATCH_SIZE,
            ),
        )
        self._conn.commit()
        return cursor.rowcount

    def find_unknown_commerce_job(self, canonical_payload: str) -> dict | None:
        """Return the earliest commerce job whose stored payload carries the
        given canonical digest and whose status is unknown, or None. Used by
        purchase_service to refuse a second signing for an already-unknown
        purchase (#1446)."""
        cursor = self._conn.execute(
            "SELECT * FROM commerce_jobs WHERE payload_json LIKE ? "
            "ORDER BY created_at ASC LIMIT 1",
            (f'%"_canonical": "{canonical_payload}"%',),
        )
        row = cursor.fetchone()
        return dict(row) if row else None

    def count_pending_commerce_jobs(self) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM commerce_queue WHERE status = 'pending'"
        ).fetchone()
        return row["cnt"] if row else 0

    def get_commerce_jobs(self, limit: int = 25) -> list[dict]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 25:
            raise ValueError("limit must be an integer from 1 to 25")
        rows = self._conn.execute(
            """SELECT job_id, talos_id, service_type, status, created_at
               FROM commerce_queue
               ORDER BY id DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]
