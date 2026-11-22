"""State retention preview by record class for local database repositories (#1451).

Scope:
    - Inspects local SQLite state repository tables and returns a privacy-safe
      retention preview broken down by record class / category.
    - Reports candidate record counts, earliest date boundary, latest date boundary,
      and policy criteria.
    - Separates private content (activity_log, content_history, playbooks,
      strategy_learnings, audience_insights, etc.) from financial records
      (spending_log, loans, loan_repayments, dividends_log, approval_cache) and
      audit records (secret_audit_events, job_effect_replay_audit, replay_events).
    - Read-only: never modifies the live database.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class RecordClass(str, Enum):
    """Broad categorization of agent state records."""

    PRIVATE_CONTENT = "private_content"
    FINANCIAL = "financial"
    AUDIT = "audit"
    OPERATIONAL = "operational"


@dataclass
class TableRetentionPreview:
    """Retention status and candidate bounds for a single table."""

    table: str
    record_class: RecordClass
    total_count: int
    candidate_count: int
    oldest_candidate: str | None = None
    newest_candidate: str | None = None
    date_column: str | None = None
    retention_policy: str = "permanent"

    def to_dict(self) -> dict[str, Any]:
        return {
            "table": self.table,
            "record_class": self.record_class.value,
            "total_count": self.total_count,
            "candidate_count": self.candidate_count,
            "oldest_candidate": self.oldest_candidate,
            "newest_candidate": self.newest_candidate,
            "date_column": self.date_column,
            "retention_policy": self.retention_policy,
        }


@dataclass
class StateRetentionPreviewReport:
    """Aggregated local state retention preview separated by record class."""

    as_of: str
    summary_by_class: dict[str, dict[str, Any]] = field(default_factory=dict)
    tables: list[TableRetentionPreview] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "as_of": self.as_of,
            "summary_by_class": self.summary_by_class,
            "tables": [t.to_dict() for t in self.tables],
        }


# Known table mappings for record classes, primary timestamp columns, and default retention guidelines
TABLE_RECORD_CLASSES: dict[str, tuple[RecordClass, str | None, str]] = {
    # Private content (content, activity, user/market facing drafts, playbooks, learned insights)
    "activity_log": (RecordClass.PRIVATE_CONTENT, "created_at", "permanent"),
    "content_history": (RecordClass.PRIVATE_CONTENT, "posted_at", "permanent"),
    "content_performance": (RecordClass.PRIVATE_CONTENT, "measured_at", "permanent"),
    "playbooks": (RecordClass.PRIVATE_CONTENT, "purchased_at", "permanent"),
    "strategy_learnings": (RecordClass.PRIVATE_CONTENT, "created_at", "30d_ttl"),
    "audience_insights": (RecordClass.PRIVATE_CONTENT, "updated_at", "permanent"),
    # Financial records (money, lending, repayments, dividends, spending, approvals)
    "spending_log": (RecordClass.FINANCIAL, "created_at", "permanent"),
    "loans": (RecordClass.FINANCIAL, "created_at", "until_repaid"),
    "loan_repayments": (RecordClass.FINANCIAL, "created_at", "permanent"),
    "dividends_log": (RecordClass.FINANCIAL, "created_at", "permanent"),
    "approval_cache": (RecordClass.FINANCIAL, "created_at", "permanent"),
    # Audit records (secret rotation audits, job effect replay audits, replay session logs)
    "secret_audit_events": (RecordClass.AUDIT, "created_at", "permanent"),
    "job_effect_replay_audit": (RecordClass.AUDIT, "created_at", "permanent"),
    "replay_events": (RecordClass.AUDIT, "recorded_at", "permanent"),
    "replay_sessions": (RecordClass.AUDIT, "created_at", "permanent"),
    # Operational / queue state (coordination, queues, completion markers, schedules)
    "completion_markers": (RecordClass.OPERATIONAL, "completed_at", "7d_ttl"),
    "cycle_summaries": (RecordClass.OPERATIONAL, "created_at", "keep_last_200"),
    "schedules": (RecordClass.OPERATIONAL, "last_run_at", "permanent"),
    "claimed_jobs": (RecordClass.OPERATIONAL, "claimed_at", "until_fulfilled"),
    "commerce_queue": (RecordClass.OPERATIONAL, "created_at", "until_consumed"),
    "retry_state": (RecordClass.OPERATIONAL, "updated_at", "until_resolved"),
    "job_inbox": (RecordClass.OPERATIONAL, "created_at", "until_fulfilled"),
    "job_effect_outbox": (RecordClass.OPERATIONAL, "created_at", "until_dispatched"),
    "telegram_send_queue": (RecordClass.OPERATIONAL, "created_at", "24h_ttl"),
    "adapter_invocations": (RecordClass.OPERATIONAL, "created_at", "permanent"),
}


def preview_table_retention(
    conn: sqlite3.Connection,
    table: str,
    record_class: RecordClass,
    date_column: str | None = None,
    retention_policy: str = "permanent",
    cutoff_iso: str | None = None,
    max_count: int = 0,
) -> TableRetentionPreview:
    """Calculate retention preview metrics for a single table."""
    cur = conn.cursor()

    # Verify table existence in SQLite schema
    exists = cur.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    if not exists:
        return TableRetentionPreview(
            table=table,
            record_class=record_class,
            total_count=0,
            candidate_count=0,
            date_column=date_column,
            retention_policy=retention_policy,
        )

    # Total rows count
    total_row = cur.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()
    total_count = int(total_row[0]) if total_row else 0

    if total_count == 0:
        return TableRetentionPreview(
            table=table,
            record_class=record_class,
            total_count=0,
            candidate_count=0,
            date_column=date_column,
            retention_policy=retention_policy,
        )

    # Check whether table has the specified date_column
    col_names = [r[1] for r in cur.execute(f'PRAGMA table_info("{table}")').fetchall()]
    actual_date_col = date_column if date_column and date_column in col_names else None

    candidate_count = 0
    oldest_candidate: str | None = None
    newest_candidate: str | None = None

    if cutoff_iso and actual_date_col:
        # Age-based candidates
        res = cur.execute(
            f'SELECT COUNT(*), MIN("{actual_date_col}"), MAX("{actual_date_col}") '
            f'FROM "{table}" WHERE "{actual_date_col}" < ?',
            (cutoff_iso,),
        ).fetchone()
        candidate_count = int(res[0]) if res and res[0] is not None else 0
        oldest_candidate = str(res[1]) if res and res[1] is not None else None
        newest_candidate = str(res[2]) if res and res[2] is not None else None
    elif max_count > 0 and total_count > max_count and actual_date_col:
        # Count-based candidates: excess older rows outside the newest max_count
        excess = total_count - max_count
        candidate_count = excess
        res = cur.execute(
            f'SELECT MIN("{actual_date_col}"), MAX("{actual_date_col}") FROM ('
            f'  SELECT "{actual_date_col}" FROM "{table}" '
            f'  ORDER BY "{actual_date_col}" ASC LIMIT ?'
            f')',
            (excess,),
        ).fetchone()
        oldest_candidate = str(res[0]) if res and res[0] is not None else None
        newest_candidate = str(res[1]) if res and res[1] is not None else None
    else:
        # No cutoff/count condition evaluated, report overall table date boundaries as candidate boundaries
        if actual_date_col:
            res = cur.execute(
                f'SELECT MIN("{actual_date_col}"), MAX("{actual_date_col}") FROM "{table}"'
            ).fetchone()
            oldest_candidate = str(res[0]) if res and res[0] is not None else None
            newest_candidate = str(res[1]) if res and res[1] is not None else None
        candidate_count = total_count

    return TableRetentionPreview(
        table=table,
        record_class=record_class,
        total_count=total_count,
        candidate_count=candidate_count,
        oldest_candidate=oldest_candidate,
        newest_candidate=newest_candidate,
        date_column=actual_date_col,
        retention_policy=retention_policy,
    )


def preview_state_retention(
    conn: sqlite3.Connection,
    *,
    record_class_filter: RecordClass | str | None = None,
    cutoff_iso: str | None = None,
    now: datetime | None = None,
) -> StateRetentionPreviewReport:
    """Generate a full local state retention preview separated by record class.

    Args:
        conn: Open SQLite connection.
        record_class_filter: Optional filter to report only a specific RecordClass.
        cutoff_iso: Optional ISO timestamp to evaluate retention expiration candidates.
        now: Optional current timestamp reference.
    """
    ref_time = now or datetime.now(timezone.utc)
    target_class = (
        RecordClass(record_class_filter)
        if isinstance(record_class_filter, str)
        else record_class_filter
    )

    table_previews: list[TableRetentionPreview] = []
    summary_by_class: dict[str, dict[str, Any]] = {
        rc.value: {
            "record_class": rc.value,
            "table_count": 0,
            "total_records": 0,
            "candidate_records": 0,
            "oldest_boundary": None,
            "newest_boundary": None,
        }
        for rc in RecordClass
    }

    # Discover all user tables
    existing_tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    }

    # Process all classified tables, plus any unexpected unmapped tables under OPERATIONAL
    all_table_names = sorted(existing_tables)

    for tbl in all_table_names:
        if tbl in TABLE_RECORD_CLASSES:
            rc, date_col, policy = TABLE_RECORD_CLASSES[tbl]
        else:
            # Fallback default for dynamic or extension tables
            rc, date_col, policy = (RecordClass.OPERATIONAL, "created_at", "unclassified")

        if target_class and rc != target_class:
            continue

        preview = preview_table_retention(
            conn=conn,
            table=tbl,
            record_class=rc,
            date_column=date_col,
            retention_policy=policy,
            cutoff_iso=cutoff_iso,
        )
        table_previews.append(preview)

        # Update summary for this class
        s = summary_by_class[rc.value]
        s["table_count"] += 1
        s["total_records"] += preview.total_count
        s["candidate_records"] += preview.candidate_count

        if preview.oldest_candidate:
            if s["oldest_boundary"] is None or preview.oldest_candidate < s["oldest_boundary"]:
                s["oldest_boundary"] = preview.oldest_candidate
        if preview.newest_candidate:
            if s["newest_boundary"] is None or preview.newest_candidate > s["newest_boundary"]:
                s["newest_boundary"] = preview.newest_candidate

    return StateRetentionPreviewReport(
        as_of=ref_time.isoformat(),
        summary_by_class=summary_by_class,
        tables=table_previews,
    )
