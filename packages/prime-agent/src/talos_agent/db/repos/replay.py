"""ReplayRepo — replay_sessions and replay_events table access."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone


class ReplayRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def create_replay_session(
        self,
        session_id: str,
        talos_id: str,
        agent_version: str,
        started_at: str,
    ) -> None:
        self._conn.execute(
            """INSERT OR IGNORE INTO replay_sessions
               (session_id, talos_id, agent_version, started_at, status)
               VALUES (?, ?, ?, ?, 'recording')""",
            (session_id, talos_id, agent_version, started_at),
        )
        self._conn.commit()

    def finish_replay_session(self, session_id: str, status: str = "completed") -> None:
        ended_at = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """UPDATE replay_sessions
               SET status = ?, ended_at = ?
               WHERE session_id = ?""",
            (status, ended_at, session_id),
        )
        self._conn.commit()

    def insert_replay_event(
        self,
        session_id: str,
        event_id: str,
        event_type: str,
        payload_json: str,
        redacted: bool = False,
    ) -> None:
        self._conn.execute(
            """INSERT INTO replay_events
               (session_id, event_id, event_type, payload, redacted)
               VALUES (?, ?, ?, ?, ?)""",
            (session_id, event_id, event_type, payload_json, int(redacted)),
        )
        self._conn.commit()

    def get_replay_events(self, session_id: str) -> list[sqlite3.Row]:
        rows = self._conn.execute(
            """SELECT event_id, event_type, payload, redacted, recorded_at
               FROM replay_events WHERE session_id = ?
               ORDER BY id ASC""",
            (session_id,),
        ).fetchall()
        return list(rows)

    def list_replay_sessions(
        self,
        talos_id: str | None = None,
        limit: int = 20,
    ) -> list[sqlite3.Row]:
        if talos_id:
            rows = self._conn.execute(
                """SELECT session_id, talos_id, agent_version, started_at, ended_at, status
                   FROM replay_sessions WHERE talos_id = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (talos_id, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT session_id, talos_id, agent_version, started_at, ended_at, status
                   FROM replay_sessions
                   ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return list(rows)
