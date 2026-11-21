"""RetryRepo — retry_state table access for durable scheduler backoff."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone


class RetryRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def upsert_retry_state(
        self,
        task_name: str,
        attempt_count: int,
        next_attempt_at: datetime,
        terminal: bool = False,
    ) -> None:
        self._conn.execute(
            """INSERT INTO retry_state (task_name, attempt_count, next_attempt_at, terminal, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(task_name) DO UPDATE SET
                   attempt_count   = excluded.attempt_count,
                   next_attempt_at = excluded.next_attempt_at,
                   terminal        = excluded.terminal,
                   updated_at      = excluded.updated_at""",
            (
                task_name,
                attempt_count,
                next_attempt_at.isoformat(),
                int(terminal),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._conn.commit()

    def save_retry_state(
        self,
        task_name: str,
        *,
        attempt_count: int,
        next_attempt_at: datetime | None,
        terminal: bool = False,
    ) -> None:
        """Keyword-alias for :meth:`upsert_retry_state` (optional next_attempt_at)."""
        self.upsert_retry_state(
            task_name,
            attempt_count,
            next_attempt_at or datetime.now(timezone.utc),
            terminal,
        )

    def get_retry_state(self, task_name: str) -> dict | None:
        row = self._conn.execute(
            "SELECT task_name, attempt_count, next_attempt_at, terminal "
            "FROM retry_state WHERE task_name = ?",
            (task_name,),
        ).fetchone()
        if row is None:
            return None
        return {
            "task_name": row["task_name"],
            "attempt_count": int(row["attempt_count"]),
            "next_attempt_at": datetime.fromisoformat(row["next_attempt_at"]),
            "terminal": bool(row["terminal"]),
        }

    def clear_retry_state(self, task_name: str) -> None:
        self._conn.execute(
            "DELETE FROM retry_state WHERE task_name = ?",
            (task_name,),
        )
        self._conn.commit()
