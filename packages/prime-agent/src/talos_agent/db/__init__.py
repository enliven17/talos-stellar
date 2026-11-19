"""Database package — per-domain repositories behind a LocalDB façade.

All names that callers previously imported from ``talos_agent.db`` are
re-exported here so existing code continues to work unchanged.
"""

from __future__ import annotations

from talos_agent.db.facade import LocalDB
from talos_agent.db.migrations import (
    DB_PATH,
    _MIGRATIONS,
    get_db_path,
    normalize_playbook_name,
    run_migrations,
)
from talos_agent.db.repos import (
    ActivityRepo,
    CommerceRepo,
    ConfigRepo,
    ContentRepo,
    CyclesRepo,
    DividendRepo,
    JobsRepo,
    LearningsRepo,
    LoanRepo,
    ReplayRepo,
    RetryRepo,
    SpendingRepo,
)

__all__ = [
    # Façade
    "LocalDB",
    # Migrations
    "DB_PATH",
    "_MIGRATIONS",
    "get_db_path",
    "normalize_playbook_name",
    "run_migrations",
    # Repositories
    "ActivityRepo",
    "CommerceRepo",
    "ConfigRepo",
    "ContentRepo",
    "CyclesRepo",
    "DividendRepo",
    "JobsRepo",
    "LearningsRepo",
    "LoanRepo",
    "ReplayRepo",
    "RetryRepo",
    "SpendingRepo",
]
