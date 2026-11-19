"""DividendRepo — dividends_log table access."""

from __future__ import annotations

import sqlite3


class DividendRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def record_dividend(
        self,
        recipient_address: str,
        token_symbol: str,
        amount: float,
        currency: str = "USDC",
        spending_log_id: int | None = None,
        tx_hash: str | None = None,
        note: str = "",
    ) -> int:
        cursor = self._conn.execute(
            """INSERT INTO dividends_log
               (spending_log_id, recipient_address, token_symbol, amount, currency, tx_hash, note)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (spending_log_id, recipient_address, token_symbol, amount, currency, tx_hash, note),
        )
        self._conn.commit()
        return cursor.lastrowid

    def get_dividend_history(self, limit: int = 50, recipient_address: str | None = None) -> list[dict]:
        if recipient_address:
            rows = self._conn.execute(
                """SELECT id, spending_log_id, recipient_address, token_symbol, amount,
                          currency, status, tx_hash, note, created_at
                   FROM dividends_log WHERE recipient_address = ?
                   ORDER BY created_at DESC LIMIT ?""",
                (recipient_address, limit),
            ).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT id, spending_log_id, recipient_address, token_symbol, amount,
                          currency, status, tx_hash, note, created_at
                   FROM dividends_log
                   ORDER BY created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
