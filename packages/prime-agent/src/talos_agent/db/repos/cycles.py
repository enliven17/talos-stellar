"""CyclesRepo — cycle_summaries table access."""

from __future__ import annotations

import json
import sqlite3


class CyclesRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save_cycle_summary(
        self,
        *,
        talos_id: str,
        cycle_id: str,
        started_at: str,
        ended_at: str,
        duration_ms: float,
        tool_calls: int,
        tool_names: list[str],
        error_type: str | None = None,
        error_category: str | None = None,
        outcome: str = "completed",
    ) -> int:
        cursor = self._conn.execute(
            """INSERT INTO cycle_summaries
               (talos_id, cycle_id, started_at, ended_at, duration_ms,
                tool_calls, tool_names, error_type, error_category, outcome)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                talos_id,
                cycle_id,
                started_at,
                ended_at,
                duration_ms,
                tool_calls,
                json.dumps(tool_names),
                error_type,
                error_category,
                outcome,
            ),
        )
        self._conn.commit()
        return cursor.lastrowid

    def get_recent_cycle_summaries(
        self,
        talos_id: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        if talos_id:
            rows = self._conn.execute(
                """SELECT id, talos_id, cycle_id, started_at, ended_at, duration_ms,
                          tool_calls, tool_names, error_type, error_category, outcome,
                          created_at
                   FROM cycle_summaries WHERE talos_id = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (talos_id, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT id, talos_id, cycle_id, started_at, ended_at, duration_ms,
                          tool_calls, tool_names, error_type, error_category, outcome,
                          created_at
                   FROM cycle_summaries
                   ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["tool_names"] = json.loads(d["tool_names"])
            except (TypeError, ValueError):
                d["tool_names"] = []
            result.append(d)
        return result

    def prune_old_cycle_summaries(
        self,
        talos_id: str | None = None,
        keep_last: int = 200,
    ) -> int:
        if keep_last <= 0:
            raise ValueError("keep_last must be a positive integer")

        if talos_id:
            rows = self._conn.execute(
                "SELECT id FROM cycle_summaries WHERE talos_id = ? ORDER BY created_at DESC",
                (talos_id,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT id FROM cycle_summaries ORDER BY created_at DESC"
            ).fetchall()

        ids_to_delete = [r["id"] for r in rows[keep_last:]]
        if ids_to_delete:
            self._conn.executemany(
                "DELETE FROM cycle_summaries WHERE id = ?",
                [(rid,) for rid in ids_to_delete],
            )
            self._conn.commit()
        return len(ids_to_delete)
