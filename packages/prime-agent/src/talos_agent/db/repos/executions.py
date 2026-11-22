"""Durable scheduler task execution identity storage."""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone


class TaskExecutionRepo:
    """Reserve one durable identity for each scheduler execution."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def reserve(self, task_name: str, owner_id: str | None = None) -> dict | None:
        owner = owner_id or str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            active = self._conn.execute(
                """
                SELECT execution_id, status FROM task_executions
                WHERE task_name = ? AND status IN ('reserved', 'uncertain')
                ORDER BY created_at DESC LIMIT 1
                """,
                (task_name,),
            ).fetchone()
            if active is not None:
                if active["status"] == "reserved":
                    self._conn.execute(
                        """
                        UPDATE task_executions
                        SET status = 'uncertain', updated_at = ?
                        WHERE execution_id = ?
                        """,
                        (now, active["execution_id"]),
                    )
                self._conn.commit()
                return None

            execution_id = str(uuid.uuid4())
            self._conn.execute(
                """
                INSERT INTO task_executions
                    (execution_id, task_name, status, owner_id, created_at, updated_at)
                VALUES (?, ?, 'reserved', ?, ?, ?)
                """,
                (execution_id, task_name, owner, now, now),
            )
            self._conn.commit()
            return {
                "execution_id": execution_id,
                "task_name": task_name,
                "owner_id": owner,
                "status": "reserved",
            }
        except Exception:
            if self._conn.in_transaction:
                self._conn.rollback()
            raise

    def finish(self, execution_id: str, status: str) -> None:
        if status not in {"succeeded", "retryable", "uncertain"}:
            raise ValueError("invalid task execution status")
        cursor = self._conn.execute(
            """
            UPDATE task_executions
            SET status = ?, updated_at = ?
            WHERE execution_id = ? AND status = 'reserved'
            """,
            (status, datetime.now(timezone.utc).isoformat(), execution_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("task execution is no longer reservable")
        self._conn.commit()

    def resolve_uncertain(self, execution_id: str, status: str) -> None:
        if status not in {"succeeded", "retryable"}:
            raise ValueError("uncertain execution must resolve to a terminal retry state")
        cursor = self._conn.execute(
            """
            UPDATE task_executions
            SET status = ?, updated_at = ?
            WHERE execution_id = ? AND status = 'uncertain'
            """,
            (status, datetime.now(timezone.utc).isoformat(), execution_id),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("task execution is not uncertain")
        self._conn.commit()

    def get(self, execution_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM task_executions WHERE execution_id = ?",
            (execution_id,),
        ).fetchone()
        return dict(row) if row else None
