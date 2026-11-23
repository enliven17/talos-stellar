"""SpendingRepo — spending_log and approval_cache table access."""

from __future__ import annotations

import sqlite3
from typing import Any


class SpendingRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    # ── Spending Tracker ────────────────────────────────────

    def record_spending(
        self,
        amount: float,
        category: str,
        description: str = "",
        currency: str = "USDC",
    ) -> None:
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

    def cache_approval(
        self,
        approval_id: str,
        type_: str,
        title: str,
        description: str | None,
        amount: float | None,
        action_digest: str | None = None,
        policy_digest: str | None = None,
        canonical_action: str | None = None,
        simulated_result_digest: str | None = None,
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO approval_cache "
            "(approval_id, type, title, description, amount, action_digest, policy_digest, canonical_action, simulated_result_digest) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                approval_id,
                type_,
                title,
                description,
                amount,
                action_digest,
                policy_digest,
                canonical_action,
                simulated_result_digest,
            ),
        )
        self._conn.commit()

    def get_approval(self, approval_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM approval_cache WHERE approval_id = ?",
            (approval_id,),
        ).fetchone()
        return dict(row) if row else None

    def save_policy_approval(self, approval: Any) -> None:
        import json

        canonical_str = json.dumps(
            {
                "action": approval.action,
                "params": approval.params,
                "context": approval.context,
            },
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        amount = None
        if isinstance(approval.params, dict) and "amount" in approval.params:
            try:
                amount = float(approval.params["amount"])
            except (ValueError, TypeError):
                pass
        self._conn.execute(
            "INSERT OR REPLACE INTO approval_cache "
            "(approval_id, type, title, description, amount, status, action_digest, policy_digest, canonical_action, simulated_result_digest) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                approval.approval_id,
                "policy_approval",
                f"Policy approval: {approval.action}",
                approval.reason or f"Action {approval.action}",
                amount,
                approval.status,
                approval.action_digest,
                approval.policy_digest,
                canonical_str,
                approval.simulated_result_digest,
            ),
        )
        self._conn.commit()

    def get_policy_approval(self, approval_id: str) -> Any | None:
        from talos_agent.policy.schema import PolicyApproval, PolicyDecision
        import json

        row = self._conn.execute(
            "SELECT * FROM approval_cache WHERE approval_id = ?",
            (approval_id,),
        ).fetchone()
        if not row:
            return None
        r = dict(row)
        params: dict[str, Any] = {}
        context: dict[str, Any] = {}
        action_name = ""
        if r.get("canonical_action"):
            try:
                parsed = json.loads(r["canonical_action"])
                if isinstance(parsed, dict):
                    action_name = parsed.get("action", "")
                    params = parsed.get("params", {})
                    context = parsed.get("context", {})
            except Exception:
                pass
        return PolicyApproval(
            approval_id=r["approval_id"],
            action=action_name,
            params=params,
            context=context,
            action_digest=r.get("action_digest") or "",
            policy_digest=r.get("policy_digest") or "",
            simulated_result_digest=r.get("simulated_result_digest") or "",
            decision=PolicyDecision.APPROVE,
            status=r.get("status", "pending"),
            created_at=r.get("created_at") or "",
            approved_at=r.get("updated_at") if r.get("status") == "approved" else None,
            reason=r.get("description") or "",
        )

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
