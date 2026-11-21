"""Per-domain repository classes sharing one SQLite connection."""

from talos_agent.db.repos.activity import ActivityRepo
from talos_agent.db.repos.commerce import CommerceRepo
from talos_agent.db.repos.config import ConfigRepo
from talos_agent.db.repos.content import ContentRepo
from talos_agent.db.repos.cycles import CyclesRepo
from talos_agent.db.repos.dividends import DividendRepo
from talos_agent.db.repos.jobs import JobsRepo
from talos_agent.db.repos.learnings import LearningsRepo
from talos_agent.db.repos.loans import LoanRepo
from talos_agent.db.repos.replay import ReplayRepo
from talos_agent.db.repos.retry import RetryRepo
from talos_agent.db.repos.spending import SpendingRepo

__all__ = [
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
