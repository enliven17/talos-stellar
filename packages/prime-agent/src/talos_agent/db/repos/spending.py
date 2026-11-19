"""SpendingRepo — spending_log and approval_cache table access."""

from __future__ import annotations

import sqlite3


class SpendingRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

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

    def get_spending_by_category_today(self) -> dict[str, float]:
        rows = self._conn.execute(
            "SELECT category, SUM(amount) as total FROM spending_log "
            "WHERE date(created_at) = date('now') GROUP BY category "
            "ORDER BY total DESC, category ASC"
        ).fetchall()
        return {row["category"]: float(row["total"]) for row in rows}

    def get_spending_by_category_period(self, days: int = 30) -> dict[str, float]:
        rows = self._conn.execute(
            "SELECT category, SUM(amount) as total FROM spending_log "
            "WHERE created_at >= datetime('now', ?) GROUP BY category "
            "ORDER BY total DESC, category ASC",
            (f"-{days} days",),
        ).fetchall()
        return {row["category"]: float(row["total"]) for row in rows}

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

    def get_pending_approval_totals(self) -> dict:
        row = self._conn.execute(
            "SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total, "
            "COALESCE(SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END), 0) as unpriced "
            "FROM approval_cache WHERE status = 'pending'"
        ).fetchone()
        return {
            "count": int(row["cnt"]),
            "total": float(row["total"]),
            "without_amount": int(row["unpriced"]),
        }
