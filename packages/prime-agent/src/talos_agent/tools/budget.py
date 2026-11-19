"""Budget tool: what the agent may still spend, before it tries to spend it."""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.tools.permissions import read_only
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# Injected by registry.build_all_tools
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]

#: Used when the Talos config has no usable ``gtmBudget``. Same default as
#: ``AgentContext`` and the policy middleware's budget context.
DEFAULT_GTM_BUDGET = 200.0

#: The "month" window. A rolling 30 days, as in ``AgentContext.spending_month``.
MONTH_DAYS = 30


def _gtm_budget() -> tuple[float, str]:
    """The monthly GTM budget and where it came from."""
    config = _db.get_talos_config() or {}
    if "gtmBudget" in config:
        try:
            return float(config["gtmBudget"]), "talos_config"
        except (TypeError, ValueError):
            pass
    return DEFAULT_GTM_BUDGET, "default"


@tool(
    "get_budget_status",
    "Get remaining budget before a purchase or transfer: spending by category "
    "(today and last 30 days), GTM budget remaining, pending approval totals "
    "and the approval threshold",
    permissions=read_only(),
)
async def get_budget_status() -> dict:
    gtm_budget, gtm_source = _gtm_budget()
    spent_today = _db.get_spending_today()
    spent_month = _db.get_spending_period(MONTH_DAYS)
    pending = _db.get_pending_approval_totals()
    remaining = gtm_budget - spent_month

    return {
        "currency": "USDC",
        "spending": {
            "today": {
                "total": spent_today,
                "by_category": _db.get_spending_by_category_today(),
            },
            "month": {
                "window_days": MONTH_DAYS,
                "total": spent_month,
                "by_category": _db.get_spending_by_category_period(MONTH_DAYS),
            },
        },
        "gtm_budget": {
            "monthly": gtm_budget,
            "source": gtm_source,
            "spent_this_month": spent_month,
            "remaining": remaining,
            "over_budget": remaining < 0,
            # What is left if every pending approval were granted and spent.
            "remaining_after_pending": remaining - pending["total"],
        },
        "pending_approvals": {
            "count": pending["count"],
            "total": pending["total"],
            "without_amount": pending["without_amount"],
        },
        "approval_threshold": float(_settings.approval_threshold),
    }
