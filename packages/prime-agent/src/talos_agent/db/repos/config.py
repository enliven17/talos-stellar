"""ConfigRepo — talos_config, playbooks, and schedules table access."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from talos_agent.db.migrations import normalize_playbook_name


class ConfigRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ── Key-Value Config ───────────────────────────────────

    def set_config(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO talos_config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self._conn.commit()

    def get_config(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM talos_config WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_talos_config(self, data: dict) -> None:
        self.set_config("talos_data", json.dumps(data))

    def get_talos_config(self) -> dict | None:
        raw = self.get_config("talos_data")
        return json.loads(raw) if raw else None

    # ── Playbooks ──────────────────────────────────────────

    def save_playbook(self, name: str, data: dict, source_talos: str | None = None) -> None:
        self._conn.execute(
            "INSERT INTO playbooks (name, data, source_talos) VALUES (?, ?, ?)",
            (name, json.dumps(data), source_talos),
        )
        self._conn.commit()

    def find_playbook_by_name(self, name: str) -> dict | None:
        normalized_name = normalize_playbook_name(name)
        row = self._conn.execute(
            "SELECT id, name, data FROM playbooks WHERE name = ? "
            "ORDER BY purchased_at DESC LIMIT 1",
            (normalized_name,),
        ).fetchone()
        if row:
            return {
                "id": row["id"],
                "name": row["name"],
                "data": json.loads(row["data"]),
            }
        return None

    def get_active_playbook(self) -> dict | None:
        row = self._conn.execute(
            "SELECT name, data FROM playbooks WHERE applied = 1 ORDER BY purchased_at DESC LIMIT 1"
        ).fetchone()
        if row:
            return {"name": row["name"], "data": json.loads(row["data"])}
        return None

    def apply_playbook(self, playbook_id: int) -> None:
        self._conn.execute("UPDATE playbooks SET applied = 0")
        self._conn.execute("UPDATE playbooks SET applied = 1 WHERE id = ?", (playbook_id,))
        self._conn.commit()

    # ── Schedules ──────────────────────────────────────────

    def get_last_run(self, task_name: str) -> datetime | None:
        row = self._conn.execute(
            "SELECT last_run_at FROM schedules WHERE task_name = ?", (task_name,)
        ).fetchone()
        if row:
            return datetime.fromisoformat(row["last_run_at"])
        return None

    def update_schedule(self, task_name: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            "INSERT INTO schedules (task_name, last_run_at) VALUES (?, ?) "
            "ON CONFLICT(task_name) DO UPDATE SET last_run_at = excluded.last_run_at",
            (task_name, now),
        )
        self._conn.commit()
