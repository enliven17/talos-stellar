"""CommerceRepo — commerce_queue table access."""

from __future__ import annotations

import json
import sqlite3


class CommerceRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def add_commerce_job(self, job_id: str, talos_id: str, service_type: str, payload: dict | None = None) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO commerce_queue (job_id, talos_id, service_type, payload) VALUES (?, ?, ?, ?)",
            (job_id, talos_id, service_type, json.dumps(payload) if payload else None),
        )
        self._conn.commit()

    def update_commerce_status(self, job_id: str, status: str) -> None:
        self._conn.execute(
            "UPDATE commerce_queue SET status = ?, updated_at = datetime('now') WHERE job_id = ?",
            (status, job_id),
        )
        self._conn.commit()

    def count_pending_commerce_jobs(self) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM commerce_queue WHERE status = 'pending'"
        ).fetchone()
        return row["cnt"] if row else 0
