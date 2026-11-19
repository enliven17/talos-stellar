"""DbFacade — high-level database interface with redacted state export.

The redacted export is designed for support investigations.  It surfaces
schema versions, row counts and selected stable IDs (e.g. job IDs, table
names) while deliberately excluding secrets, prompts, and purchased private
content (playbook payloads, strategy insights, audience descriptions).

Usage
-----
Obtain a redacted snapshot::

    from talos_agent.db.facade import DbFacade

    facade = DbFacade(db)
    export = facade.redacted_export()
    print(export.to_dict())

Excluded fields
---------------
The following are **never** included in the export:

* ``playbooks.data`` — purchased playbook payload (private content)
* ``playbooks.source_talos`` — source agent identity
* ``strategy_learnings.insight`` / ``evidence`` — agent reasoning traces
* ``audience_insights.description`` / ``keywords`` — profiling data
* ``activity_log.content`` — may contain drafted messages
* ``content_history.content`` — published text (may be private)
* ``talos_config.value`` — may contain API keys or sensitive config
* ``approval_cache.description`` — may describe financial intent

Included fields
---------------
* Schema version (``PRAGMA user_version``)
* Row counts per table
* Stable non-secret IDs: ``commerce_queue.job_id``, ``approval_cache.approval_id``
* Status values for commerce jobs and approvals
* Aggregate spending totals (amount only, no descriptions)
* Loan metadata (platform, amount, status, due_date) — no purpose or address
* Retry state task names and attempt counts — no timing details
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from talos_agent.db import LocalDB as _LocalDB


# ── Redacted export dataclass ─────────────────────────────────────────────────


@dataclass
class RedactedStateExport:
    """Redacted snapshot of the local SQLite database for support investigations.

    All fields are safe to share externally.  No secrets, prompts, or private
    content are included.
    """

    schema_version: int
    """Current ``PRAGMA user_version`` of the database."""

    table_counts: dict[str, int] = field(default_factory=dict)
    """Row count per table.  Includes every table regardless of content."""

    commerce_job_ids: list[str] = field(default_factory=list)
    """Stable job IDs from ``commerce_queue`` (no payloads)."""

    commerce_statuses: dict[str, int] = field(default_factory=dict)
    """Count of commerce jobs per status value (e.g. ``{"pending": 3}``)."""

    approval_ids: list[str] = field(default_factory=list)
    """Stable approval IDs from ``approval_cache`` (no descriptions)."""

    approval_statuses: dict[str, int] = field(default_factory=dict)
    """Count of approvals per status value."""

    spending_total_usdc: float = 0.0
    """Sum of all recorded USDC spending (amount only, no descriptions)."""

    loan_summary: list[dict] = field(default_factory=list)
    """Per-loan metadata: platform, amount, status, due_date.
    Excludes purpose, repayment_address and collateral details."""

    retry_task_names: list[str] = field(default_factory=list)
    """Names of tasks that have persisted retry state."""

    retry_attempt_counts: dict[str, int] = field(default_factory=dict)
    """Attempt count per retry task (task_name → attempt_count)."""

    generated_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "schema_version": self.schema_version,
            "table_counts": self.table_counts,
            "commerce_job_ids": self.commerce_job_ids,
            "commerce_statuses": self.commerce_statuses,
            "approval_ids": self.approval_ids,
            "approval_statuses": self.approval_statuses,
            "spending_total_usdc": self.spending_total_usdc,
            "loan_summary": self.loan_summary,
            "retry_task_names": self.retry_task_names,
            "retry_attempt_counts": self.retry_attempt_counts,
            "generated_at": self.generated_at.isoformat(),
        }


# ── Tables to count ───────────────────────────────────────────────────────────

_COUNTED_TABLES = [
    "schedules",
    "activity_log",
    "content_history",
    "commerce_queue",
    "approval_cache",
    "spending_log",
    "talos_config",
    "playbooks",
    "content_performance",
    "strategy_learnings",
    "audience_insights",
    "dividends_log",
    "loans",
    "loan_repayments",
    "retry_state",
]


# ── Facade ────────────────────────────────────────────────────────────────────


class DbFacade:
    """Higher-level database interface layered on top of :class:`~talos_agent.db.LocalDB`.

    Parameters
    ----------
    db:
        A :class:`~talos_agent.db.LocalDB` instance (or any object whose
        ``_conn`` attribute is a live ``sqlite3.Connection``).
    """

    def __init__(self, db) -> None:
        self._db = db

    # ── Redacted export ───────────────────────────────────────

    def redacted_export(self) -> RedactedStateExport:
        """Return a :class:`RedactedStateExport` suitable for support investigations.

        The method queries the live database for counts and stable IDs.
        It never reads secret fields (config values, playbook payloads,
        content text, descriptions, or addresses).
        """
        conn = self._db._conn

        # Schema version
        schema_version: int = conn.execute("PRAGMA user_version;").fetchone()[0]

        # Row counts
        table_counts: dict[str, int] = {}
        for table in _COUNTED_TABLES:
            try:
                row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()  # noqa: S608
                table_counts[table] = row[0] if row else 0
            except Exception:
                # Table may not exist in older schema versions
                table_counts[table] = 0

        # Commerce job IDs and status distribution (no payloads)
        commerce_rows = conn.execute(
            "SELECT job_id, status FROM commerce_queue ORDER BY created_at ASC"
        ).fetchall()
        commerce_job_ids = [r[0] for r in commerce_rows if r[0]]
        commerce_statuses: dict[str, int] = {}
        for _, status in commerce_rows:
            commerce_statuses[status] = commerce_statuses.get(status, 0) + 1

        # Approval IDs and status distribution (no descriptions)
        approval_rows = conn.execute(
            "SELECT approval_id, status FROM approval_cache ORDER BY created_at ASC"
        ).fetchall()
        approval_ids = [r[0] for r in approval_rows if r[0]]
        approval_statuses: dict[str, int] = {}
        for _, status in approval_rows:
            approval_statuses[status] = approval_statuses.get(status, 0) + 1

        # Aggregate spending (USDC only, no descriptions)
        spending_row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0.0) FROM spending_log WHERE currency = 'USDC'"
        ).fetchone()
        spending_total_usdc = float(spending_row[0]) if spending_row else 0.0

        # Loan metadata — platform, amount, status, due_date only
        loan_rows = conn.execute(
            "SELECT id, platform, amount, status, due_date FROM loans ORDER BY created_at ASC"
        ).fetchall()
        loan_summary = [
            {
                "id": r[0],
                "platform": r[1],
                "amount": r[2],
                "status": r[3],
                "due_date": r[4],
            }
            for r in loan_rows
        ]

        # Retry state — task names and attempt counts only
        retry_rows = conn.execute(
            "SELECT task_name, attempt_count FROM retry_state ORDER BY task_name ASC"
        ).fetchall()
        retry_task_names = [r[0] for r in retry_rows]
        retry_attempt_counts = {r[0]: r[1] for r in retry_rows}

        return RedactedStateExport(
            schema_version=schema_version,
            table_counts=table_counts,
            commerce_job_ids=commerce_job_ids,
            commerce_statuses=commerce_statuses,
            approval_ids=approval_ids,
            approval_statuses=approval_statuses,
            spending_total_usdc=spending_total_usdc,
            loan_summary=loan_summary,
            retry_task_names=retry_task_names,
            retry_attempt_counts=retry_attempt_counts,
        )
