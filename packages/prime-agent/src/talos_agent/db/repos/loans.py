"""LoanRepo — loans and loan_repayments table access."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone


class LoanRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def create_loan(
        self,
        platform: str,
        amount: float,
        collateral_asset: str,
        loan_asset: str,
        duration_days: int,
        purpose: str = "",
        repayment_address: str | None = None,
    ) -> int:
        created_at = datetime.now(timezone.utc)
        due_date = created_at + timedelta(days=duration_days)
        cursor = self._conn.execute(
            """INSERT INTO loans
               (platform, amount, collateral_asset, loan_asset, duration_days, purpose,
                repayment_address, outstanding_amount, created_at, due_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (platform, amount, collateral_asset, loan_asset, duration_days, purpose,
             repayment_address, amount, created_at.isoformat(), due_date.isoformat()),
        )
        self._conn.commit()
        return cursor.lastrowid

    def get_active_loans(self) -> list[dict]:
        rows = self._conn.execute(
            """SELECT id, platform, amount, collateral_asset, loan_asset, duration_days,
                      purpose, repayment_address, status, outstanding_amount, created_at, due_date
               FROM loans WHERE status = 'active'
               ORDER BY due_date ASC"""
        ).fetchall()
        return [dict(r) for r in rows]

    def get_loan_by_id(self, loan_id: int) -> dict | None:
        row = self._conn.execute(
            """SELECT id, platform, amount, collateral_asset, loan_asset, duration_days,
                      purpose, repayment_address, status, outstanding_amount, created_at, due_date
               FROM loans WHERE id = ?""",
            (loan_id,),
        ).fetchone()
        return dict(row) if row else None

    def record_repayment(self, loan_id: int, amount: float, tx_hash: str | None = None) -> None:
        self._conn.execute(
            "INSERT INTO loan_repayments (loan_id, amount, tx_hash) VALUES (?, ?, ?)",
            (loan_id, amount, tx_hash),
        )
        self._conn.execute(
            """UPDATE loans
               SET outstanding_amount = outstanding_amount - ?,
                   updated_at = datetime('now')
               WHERE id = ?""",
            (amount, loan_id),
        )
        loan = self.get_loan_by_id(loan_id)
        if loan and loan["outstanding_amount"] <= 0:
            self._conn.execute(
                "UPDATE loans SET status = 'repaid', updated_at = datetime('now') WHERE id = ?",
                (loan_id,),
            )
        self._conn.commit()

    def get_loans_due_soon(self, days: int = 7) -> list[dict]:
        rows = self._conn.execute(
            """SELECT id, platform, amount, collateral_asset, loan_asset, duration_days,
                      purpose, repayment_address, status, outstanding_amount, created_at, due_date
               FROM loans
               WHERE status = 'active' AND due_date <= datetime('now', ?)
               ORDER BY due_date ASC""",
            (f"+{days} days",),
        ).fetchall()
        return [dict(r) for r in rows]
