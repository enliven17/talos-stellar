"""RetryRepo — retry_state table access for durable scheduler backoff."""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone

_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


_IDENTIFIER_LIKE_RE = re.compile(r"^[a-zA-Z0-9_\-\.]{1,64}$")


def normalize_error_code(code_or_exc: object) -> str:
    """Normalize an error code or exception into a safe, bounded stable error code.

    Enforces snake_case format ^[a-z][a-z0-9_]{0,63}$ without leaking prompts,
    credentials, or arbitrary exception messages.
    """
    if code_or_exc is None:
        return "unknown_error"

    if isinstance(code_or_exc, Exception):
        # Check for explicit code attribute (e.g. JobEffectError)
        code_attr = getattr(code_or_exc, "code", None)
        if isinstance(code_attr, str) and _ERROR_CODE_RE.fullmatch(code_attr):
            return code_attr
        # Use exception class name converted to snake_case
        raw = type(code_or_exc).__name__
    elif isinstance(code_or_exc, str):
        candidate = code_or_exc.strip()
        if _ERROR_CODE_RE.fullmatch(candidate):
            return candidate
        # Only accept single-token identifiers / codes without whitespace, quotes, or colons
        if _IDENTIFIER_LIKE_RE.fullmatch(candidate):
            raw = candidate
        else:
            # Free-form text (e.g. error message, prompt text, response body) -> safe fallback
            return "unexpected_error"
    else:
        raw = type(code_or_exc).__name__

    # Convert PascalCase / camelCase / hyphenated to snake_case
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", raw)
    s2 = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1)
    s3 = re.sub(r"[^a-zA-Z0-9_]+", "_", s2).strip("_").lower()

    if not s3 or not s3[0].isalpha():
        s3 = f"err_{s3}" if s3 else "unknown_error"

    s3 = s3[:64].rstrip("_")
    if _ERROR_CODE_RE.fullmatch(s3):
        return s3
    return "unknown_error"


class RetryRepo:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def upsert_retry_state(
        self,
        task_name: str,
        attempt_count: int,
        next_attempt_at: datetime,
        terminal: bool = False,
    ) -> None:
        self._conn.execute(
            """INSERT INTO retry_state (task_name, attempt_count, next_attempt_at, terminal, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(task_name) DO UPDATE SET
                   attempt_count   = excluded.attempt_count,
                   next_attempt_at = excluded.next_attempt_at,
                   terminal        = excluded.terminal,
                   updated_at      = excluded.updated_at""",
            (
                task_name,
                attempt_count,
                next_attempt_at.isoformat(),
                int(terminal),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._conn.commit()

    def save_retry_state(
        self,
        task_name: str,
        *,
        attempt_count: int,
        next_attempt_at: datetime | None,
        terminal: bool = False,
    ) -> None:
        """Keyword-alias for :meth:`upsert_retry_state` (optional next_attempt_at)."""
        self.upsert_retry_state(
            task_name,
            attempt_count,
            next_attempt_at or datetime.now(timezone.utc),
            terminal,
        )

    def get_retry_state(self, task_name: str) -> dict | None:
        row = self._conn.execute(
            "SELECT task_name, attempt_count, next_attempt_at, terminal "
            "FROM retry_state WHERE task_name = ?",
            (task_name,),
        ).fetchone()
        if row is None:
            return None
        return {
            "task_name": row["task_name"],
            "attempt_count": int(row["attempt_count"]),
            "next_attempt_at": datetime.fromisoformat(row["next_attempt_at"]),
            "terminal": bool(row["terminal"]),
        }

    def clear_retry_state(self, task_name: str) -> None:
        self._conn.execute(
            "DELETE FROM retry_state WHERE task_name = ?",
            (task_name,),
        )
        self._conn.commit()

    def record_task_failure(
        self,
        *,
        talos_id: str = "",
        task_name: str,
        attempt_number: int,
        error_code: object,
        next_eligible_at: datetime | str,
        max_history: int = 100,
    ) -> int:
        """Record a task failure event and prune old records beyond max_history.

        Retains attempts, stable error codes, and next eligibility timestamps.
        Never stores prompts, credentials, or tool results.
        """
        stable_code = normalize_error_code(error_code)
        eligible_str = (
            next_eligible_at.isoformat()
            if isinstance(next_eligible_at, datetime)
            else str(next_eligible_at)
        )

        cursor = self._conn.cursor()
        cursor.execute(
            """INSERT INTO task_failure_history (talos_id, task_name, attempt_number, error_code, next_eligible_at, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                talos_id or "",
                task_name,
                int(attempt_number),
                stable_code,
                eligible_str,
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        record_id = cursor.lastrowid or 0

        # Prune if max_history is bounded
        if max_history > 0:
            self.prune_task_failure_history(
                talos_id=talos_id,
                task_name=task_name,
                keep_last=max_history,
            )

        self._conn.commit()
        return record_id

    def get_task_failure_history(
        self,
        talos_id: str | None = None,
        task_name: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """Return failure history rows ordered newest to oldest."""
        clauses = []
        params: list[object] = []

        if talos_id is not None:
            clauses.append("talos_id = ?")
            params.append(talos_id)
        if task_name is not None:
            clauses.append("task_name = ?")
            params.append(task_name)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        query = f"""
            SELECT id, talos_id, task_name, attempt_number, error_code, next_eligible_at, recorded_at
            FROM task_failure_history
            {where}
            ORDER BY recorded_at DESC, id DESC
            LIMIT ?
        """
        params.append(limit)
        rows = self._conn.execute(query, params).fetchall()

        return [
            {
                "id": row["id"],
                "talos_id": row["talos_id"],
                "task_name": row["task_name"],
                "attempt_number": int(row["attempt_number"]),
                "error_code": row["error_code"],
                "next_eligible_at": datetime.fromisoformat(row["next_eligible_at"]),
                "recorded_at": row["recorded_at"],
            }
            for row in rows
        ]

    def prune_task_failure_history(
        self,
        talos_id: str | None = None,
        task_name: str | None = None,
        keep_last: int = 100,
    ) -> int:
        """Prune older failure records beyond keep_last per talos_id/task_name."""
        clauses = []
        params: list[object] = []
        if talos_id is not None:
            clauses.append("talos_id = ?")
            params.append(talos_id)
        if task_name is not None:
            clauses.append("task_name = ?")
            params.append(task_name)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        query = f"SELECT id FROM task_failure_history {where} ORDER BY recorded_at DESC, id DESC"
        rows = self._conn.execute(query, params).fetchall()

        if len(rows) <= keep_last:
            return 0

        stale_ids = [row["id"] for row in rows[keep_last:]]
        cursor = self._conn.cursor()
        cursor.executemany("DELETE FROM task_failure_history WHERE id = ?", [(i,) for i in stale_ids])
        self._conn.commit()
        return len(stale_ids)

