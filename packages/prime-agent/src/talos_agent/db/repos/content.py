"""ContentRepo — content_history and content_performance table access."""

from __future__ import annotations

import sqlite3


class ContentRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def add_content(self, content: str, channel: str) -> int:
        cursor = self._conn.execute(
            "INSERT INTO content_history (content, channel) VALUES (?, ?)",
            (content, channel),
        )
        self._conn.commit()
        return int(cursor.lastrowid)

    def get_content(self, content_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT id, content, channel, posted_at FROM content_history WHERE id = ?",
            (content_id,),
        ).fetchone()
        return dict(row) if row else None

    def content_exists(self, content_id: int) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM content_history WHERE id = ?",
            (content_id,),
        ).fetchone()
        return row is not None

    def get_recent_content(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT content, channel, posted_at FROM content_history ORDER BY posted_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_recent_content_by_channel(self, channel: str, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT content, channel, posted_at FROM content_history "
            "WHERE channel = ? ORDER BY posted_at DESC LIMIT ?",
            (channel, limit),
        ).fetchall()
        return [dict(r) for r in rows]

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

    def get_performance_summary_by_channel(self, channel: str, days: int = 7) -> dict:
        row = self._conn.execute(
            "SELECT COUNT(*) as total_posts, "
            "COALESCE(SUM(cp.likes), 0) as total_likes, "
            "COALESCE(SUM(cp.reposts), 0) as total_reposts, "
            "COALESCE(SUM(cp.replies), 0) as total_replies, "
            "COALESCE(SUM(cp.impressions), 0) as total_impressions, "
            "COALESCE(AVG(cp.likes + cp.reposts * 2 + cp.replies * 1.5), 0) as avg_engagement "
            "FROM content_history ch "
            "LEFT JOIN content_performance cp ON cp.content_id = ch.id "
            "WHERE ch.channel = ? AND ch.posted_at >= datetime('now', ?)",
            (channel, f"-{days} days"),
        ).fetchone()
        return dict(row) if row else {}
