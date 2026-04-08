"""SQLite local database — schedule state, caches, activity buffer."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from talos_agent.config import APP_DIR

DB_PATH = APP_DIR / "talos-agent.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schedules (
    task_name   TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    content    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    content    TEXT NOT NULL,
    channel    TEXT NOT NULL,
    posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commerce_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          TEXT UNIQUE,
    talos_id       TEXT NOT NULL,
    service_type    TEXT NOT NULL,
    payload         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approval_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id     TEXT UNIQUE,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    amount          REAL,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spending_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    amount      REAL NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'USDC',
    category    TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS talos_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    data        TEXT NOT NULL,
    source_talos TEXT,
    applied     INTEGER NOT NULL DEFAULT 0,
    purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_performance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id  INTEGER REFERENCES content_history(id),
    channel     TEXT NOT NULL,
    likes       INTEGER NOT NULL DEFAULT 0,
    reposts     INTEGER NOT NULL DEFAULT 0,
    replies     INTEGER NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    followers_at INTEGER NOT NULL DEFAULT 0,
    measured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_learnings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    insight     TEXT NOT NULL,
    evidence    TEXT,
    confidence  REAL NOT NULL DEFAULT 0.5,
    applied     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT
);

CREATE TABLE IF NOT EXISTS audience_insights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    segment     TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    engagement_score REAL NOT NULL DEFAULT 0.0,
    keywords    TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


class LocalDB:
    def __init__(self, path: Path = DB_PATH):
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)

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

    # ── Activity Log ───────────────────────────────────────

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

    # ── Content History ────────────────────────────────────

    def add_content(self, content: str, channel: str) -> None:
        self._conn.execute(
            "INSERT INTO content_history (content, channel) VALUES (?, ?)",
            (content, channel),
        )
        self._conn.commit()

    def get_recent_content(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT content, channel, posted_at FROM content_history ORDER BY posted_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Commerce Queue ─────────────────────────────────────

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

    # ── Approval Cache ─────────────────────────────────────

    def cache_approval(self, approval_id: str, type_: str, title: str, description: str | None, amount: float | None) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO approval_cache (approval_id, type, title, description, amount) VALUES (?, ?, ?, ?, ?)",
            (approval_id, type_, title, description, amount),
        )
        self._conn.commit()

    def get_pending_approvals(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM approval_cache WHERE status = 'pending'"
        ).fetchall()
        return [dict(r) for r in rows]

    def update_approval_status(self, approval_id: str, status: str) -> None:
        self._conn.execute(
            "UPDATE approval_cache SET status = ?, updated_at = datetime('now') WHERE approval_id = ?",
            (status, approval_id),
        )
        self._conn.commit()

    # ── Talos Config Cache ────────────────────────────────

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

    # ── Spending Tracker ────────────────────────────────────

    def record_spending(self, amount: float, category: str, description: str = "", currency: str = "USDC") -> None:
        self._conn.execute(
            "INSERT INTO spending_log (amount, currency, category, description) VALUES (?, ?, ?, ?)",
            (amount, currency, category, description),
        )
        self._conn.commit()

    def get_spending_today(self) -> float:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(amount), 0) as total FROM spending_log WHERE date(created_at) = date('now')"
        ).fetchone()
        return float(row["total"]) if row else 0.0

    def get_spending_period(self, days: int = 30) -> float:
        row = self._conn.execute(
            "SELECT COALESCE(SUM(amount), 0) as total FROM spending_log "
            "WHERE created_at >= datetime('now', ?)",
            (f"-{days} days",),
        ).fetchone()
        return float(row["total"]) if row else 0.0

    # ── Content Performance ─────────────────────────────────

    def record_performance(
        self,
        content_id: int,
        channel: str,
        likes: int = 0,
        reposts: int = 0,
        replies: int = 0,
        impressions: int = 0,
        followers_at: int = 0,
    ) -> None:
        self._conn.execute(
            "INSERT INTO content_performance "
            "(content_id, channel, likes, reposts, replies, impressions, followers_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (content_id, channel, likes, reposts, replies, impressions, followers_at),
        )
        self._conn.commit()

    def get_content_with_performance(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT ch.id, ch.content, ch.channel, ch.posted_at, "
            "COALESCE(cp.likes, 0) as likes, COALESCE(cp.reposts, 0) as reposts, "
            "COALESCE(cp.replies, 0) as replies, COALESCE(cp.impressions, 0) as impressions, "
            "cp.measured_at "
            "FROM content_history ch "
            "LEFT JOIN content_performance cp ON cp.content_id = ch.id "
            "ORDER BY ch.posted_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_unmeasured_content(self, limit: int = 10) -> list[dict]:
        rows = self._conn.execute(
            "SELECT ch.id, ch.content, ch.channel, ch.posted_at "
            "FROM content_history ch "
            "LEFT JOIN content_performance cp ON cp.content_id = ch.id "
            "WHERE cp.id IS NULL "
            "AND ch.posted_at >= datetime('now', '-7 days') "
            "ORDER BY ch.posted_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_top_performing_content(self, limit: int = 5) -> list[dict]:
        rows = self._conn.execute(
            "SELECT ch.content, ch.channel, ch.posted_at, "
            "cp.likes, cp.reposts, cp.replies, cp.impressions, "
            "(cp.likes + cp.reposts * 2 + cp.replies * 1.5) as engagement_score "
            "FROM content_history ch "
            "JOIN content_performance cp ON cp.content_id = ch.id "
            "ORDER BY engagement_score DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_performance_summary(self, days: int = 7) -> dict:
        row = self._conn.execute(
            "SELECT COUNT(*) as total_posts, "
            "COALESCE(SUM(cp.likes), 0) as total_likes, "
            "COALESCE(SUM(cp.reposts), 0) as total_reposts, "
            "COALESCE(SUM(cp.replies), 0) as total_replies, "
            "COALESCE(SUM(cp.impressions), 0) as total_impressions, "
            "COALESCE(AVG(cp.likes + cp.reposts * 2 + cp.replies * 1.5), 0) as avg_engagement "
            "FROM content_history ch "
            "LEFT JOIN content_performance cp ON cp.content_id = ch.id "
            "WHERE ch.posted_at >= datetime('now', ?)",
            (f"-{days} days",),
        ).fetchone()
        return dict(row) if row else {}

    # ── Strategy Learnings ─────────────────────────────────

    def save_learning(
        self,
        category: str,
        insight: str,
        evidence: str = "",
        confidence: float = 0.5,
        expires_days: int | None = 30,
    ) -> int:
        expires_at_str: str | None = None
        if expires_days:
            expires_at_str = (
                datetime.now(timezone.utc) + timedelta(days=expires_days)
            ).isoformat()
        self._conn.execute(
            "INSERT INTO strategy_learnings (category, insight, evidence, confidence, expires_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (category, insight, evidence, confidence, expires_at_str),
        )
        self._conn.commit()
        return self._conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def get_active_learnings(self, limit: int = 10) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, category, insight, evidence, confidence, created_at "
            "FROM strategy_learnings "
            "WHERE (expires_at IS NULL OR expires_at > datetime('now')) "
            "ORDER BY confidence DESC, created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def mark_learning_applied(self, learning_id: int) -> None:
        self._conn.execute(
            "UPDATE strategy_learnings SET applied = 1 WHERE id = ?", (learning_id,)
        )
        self._conn.commit()

    # ── Audience Insights ──────────────────────────────────

    def upsert_audience_insight(
        self,
        segment: str,
        description: str,
        engagement_score: float = 0.0,
        keywords: list[str] | None = None,
    ) -> None:
        self._conn.execute(
            "INSERT INTO audience_insights (segment, description, engagement_score, keywords) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(segment) DO UPDATE SET "
            "description = excluded.description, "
            "engagement_score = excluded.engagement_score, "
            "keywords = excluded.keywords, "
            "updated_at = datetime('now')",
            (segment, description, engagement_score, json.dumps(keywords) if keywords else None),
        )
        self._conn.commit()

    def get_audience_insights(self, limit: int = 5) -> list[dict]:
        rows = self._conn.execute(
            "SELECT segment, description, engagement_score, keywords, updated_at "
            "FROM audience_insights ORDER BY engagement_score DESC LIMIT ?",
            (limit,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("keywords"):
                d["keywords"] = json.loads(d["keywords"])
            result.append(d)
        return result

    # ── Cleanup ────────────────────────────────────────────

    def close(self) -> None:
        self._conn.close()
