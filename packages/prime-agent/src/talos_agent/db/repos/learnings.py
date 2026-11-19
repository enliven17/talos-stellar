"""LearningsRepo — strategy_learnings and audience_insights table access."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone


class LearningsRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

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

    def evict_expired_learnings(self, *, now: datetime | None = None) -> dict:
        clock = now or datetime.now(timezone.utc)
        cutoff = clock.isoformat()
        rows = self._conn.execute(
            "SELECT id FROM strategy_learnings "
            "WHERE expires_at IS NOT NULL AND expires_at <= ?",
            (cutoff,),
        ).fetchall()
        ids = [int(r["id"] if isinstance(r, dict) or hasattr(r, "keys") else r[0]) for r in rows]
        if ids:
            self._conn.execute(
                f"DELETE FROM strategy_learnings WHERE id IN ({','.join('?' for _ in ids)})",
                ids,
            )
            self._conn.commit()
        return {"evicted": len(ids), "ids": ids}

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
