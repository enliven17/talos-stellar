"""Persistent storage for replay sessions using the existing LocalDB SQLite instance.

Schema (migration v9)
---------------------
replay_sessions   – one row per captured agent cycle
replay_events     – one row per event in a cycle

Design notes
------------
* Uses the same SQLite WAL-mode connection already managed by ``LocalDB``.
* A session's ``status`` moves: ``recording`` → ``complete`` | ``error``.
* All payload JSON is pre-redacted before storage (by EventCapture).
* ``list_sessions`` and ``get_events`` are read-only helpers for the CLI.
* ``prune_sessions`` lets operators cap disk usage.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from talos_agent.replay.capture import EventCapture, ReplayEvent

# ── SQL ───────────────────────────────────────────────────────────────────────

_CREATE_SESSIONS = """
CREATE TABLE IF NOT EXISTS replay_sessions (
    cycle_id        TEXT PRIMARY KEY,
    talos_id        TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    status          TEXT NOT NULL DEFAULT 'recording'
                        CHECK(status IN ('recording', 'complete', 'error')),
    event_count     INTEGER NOT NULL DEFAULT 0,
    dropped_events  INTEGER NOT NULL DEFAULT 0,
    agent_version   TEXT NOT NULL DEFAULT '',
    meta            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_talos_started
    ON replay_sessions(talos_id, started_at DESC);
"""

_CREATE_EVENTS = """
CREATE TABLE IF NOT EXISTS replay_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id    TEXT NOT NULL REFERENCES replay_sessions(cycle_id),
    event_id    TEXT NOT NULL UNIQUE,
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    ts          TEXT NOT NULL,
    payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replay_events_cycle_seq
    ON replay_events(cycle_id, seq);
"""


class ReplayStore:
    """Wraps a ``sqlite3.Connection`` (from LocalDB) for replay persistence."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._ensure_schema()

    # ── Schema bootstrap ──────────────────────────────────────────────────

    def _ensure_schema(self) -> None:
        """Create replay tables if they don't exist yet (idempotent)."""
        for ddl in (_CREATE_SESSIONS, _CREATE_EVENTS):
            for stmt in ddl.strip().split(";"):
                stmt = stmt.strip()
                if stmt:
                    self._conn.execute(stmt)
        self._conn.commit()

    # ── Write path ────────────────────────────────────────────────────────

    def start_session(
        self,
        cycle_id: str,
        talos_id: str,
        agent_version: str,
        meta: dict[str, Any] | None = None,
    ) -> None:
        """Insert a new 'recording' session row."""
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            INSERT INTO replay_sessions (cycle_id, talos_id, started_at, status, agent_version, meta)
            VALUES (?, ?, ?, 'recording', ?, ?)
            ON CONFLICT(cycle_id) DO NOTHING
            """,
            (cycle_id, talos_id, now, agent_version, json.dumps(meta or {})),
        )
        self._conn.commit()

    def flush_capture(self, capture: EventCapture) -> int:
        """Persist all events from an ``EventCapture`` to the DB.

        Returns the number of events written.
        """
        events = capture.events
        if not events:
            return 0

        rows = [
            (
                ev.event_id,
                ev.cycle_id,
                ev.seq,
                ev.kind,
                ev.ts,
                json.dumps(ev.payload, sort_keys=True, ensure_ascii=False),
            )
            for ev in events
        ]

        self._conn.executemany(
            """
            INSERT OR IGNORE INTO replay_events
                (event_id, cycle_id, seq, kind, ts, payload)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        self._conn.commit()
        return len(rows)

    def end_session(
        self,
        cycle_id: str,
        *,
        status: str = "complete",
        dropped_events: int = 0,
        event_count: int = 0,
    ) -> None:
        """Mark a session as complete or error."""
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """
            UPDATE replay_sessions
               SET status = ?, ended_at = ?, event_count = ?, dropped_events = ?
             WHERE cycle_id = ?
            """,
            (status, now, event_count, dropped_events, cycle_id),
        )
        self._conn.commit()

    # ── Read path ─────────────────────────────────────────────────────────

    def list_sessions(
        self,
        talos_id: str | None = None,
        limit: int = 20,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List replay sessions, most-recent first."""
        filters = []
        params: list[Any] = []
        if talos_id:
            filters.append("talos_id = ?")
            params.append(talos_id)
        if status:
            filters.append("status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        params.append(limit)
        rows = self._conn.execute(
            f"""
            SELECT cycle_id, talos_id, started_at, ended_at, status,
                   event_count, dropped_events, agent_version, meta
              FROM replay_sessions
             {where}
             ORDER BY started_at DESC
             LIMIT ?
            """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def get_session(self, cycle_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM replay_sessions WHERE cycle_id = ?", (cycle_id,)
        ).fetchone()
        return dict(row) if row else None

    def get_events(
        self,
        cycle_id: str,
        kind: str | None = None,
        limit: int = 1000,
    ) -> list[ReplayEvent]:
        """Load events for a cycle, decoded into ``ReplayEvent`` objects."""
        filters = ["cycle_id = ?"]
        params: list[Any] = [cycle_id]
        if kind:
            filters.append("kind = ?")
            params.append(kind)
        params.append(limit)

        rows = self._conn.execute(
            f"""
            SELECT event_id, cycle_id, seq, kind, ts, payload
              FROM replay_events
             WHERE {' AND '.join(filters)}
             ORDER BY seq ASC
             LIMIT ?
            """,
            params,
        ).fetchall()

        return [
            ReplayEvent(
                event_id=r["event_id"],
                cycle_id=r["cycle_id"],
                seq=r["seq"],
                kind=r["kind"],
                ts=r["ts"],
                payload=json.loads(r["payload"]),
            )
            for r in rows
        ]

    # ── Maintenance ───────────────────────────────────────────────────────

    def prune_sessions(self, keep_last: int = 100, talos_id: str | None = None) -> int:
        """Delete oldest sessions beyond *keep_last* for a given talos_id.

        Returns the number of sessions deleted.
        """
        filters = ["1=1"]
        params: list[Any] = []
        if talos_id:
            filters.append("talos_id = ?")
            params.append(talos_id)
        where = f"WHERE {' AND '.join(filters)}"

        # Find cycle_ids to delete
        to_delete = self._conn.execute(
            f"""
            SELECT cycle_id FROM replay_sessions {where}
             ORDER BY started_at DESC
             LIMIT -1 OFFSET ?
            """,
            params + [keep_last],
        ).fetchall()

        if not to_delete:
            return 0

        ids = [r["cycle_id"] for r in to_delete]
        placeholders = ",".join("?" for _ in ids)
        self._conn.execute(
            f"DELETE FROM replay_events WHERE cycle_id IN ({placeholders})", ids
        )
        self._conn.execute(
            f"DELETE FROM replay_sessions WHERE cycle_id IN ({placeholders})", ids
        )
        self._conn.commit()
        return len(ids)
