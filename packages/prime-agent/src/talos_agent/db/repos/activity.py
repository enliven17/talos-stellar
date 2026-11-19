"""ActivityRepo — activity_log table access."""

from __future__ import annotations

import sqlite3


class ActivityRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def add_activity(self, type_: str, content: str, channel: str) -> None:
        self._conn.execute(
            "INSERT INTO activity_log (type, content, channel) VALUES (?, ?, ?)",
            (type_, content, channel),
        )
        self._conn.commit()

    def get_pending_activities(self, limit: int = 50) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, type, content, channel FROM activity_log WHERE status = 'pending' LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_activities_sent(self, ids: list[int]) -> None:
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        self._conn.execute(
            f"UPDATE activity_log SET status = 'sent' WHERE id IN ({placeholders})", ids
        )
        self._conn.commit()

    def count_today(self, type_: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM activity_log WHERE type = ? AND date(created_at) = date('now')",
            (type_,),
        ).fetchone()
        return row["cnt"] if row else 0

    def count_today_by_channel(self, type_: str, channel: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM activity_log "
            "WHERE type = ? AND channel = ? AND date(created_at) = date('now')",
            (type_, channel),
        ).fetchone()
        return row["cnt"] if row else 0
