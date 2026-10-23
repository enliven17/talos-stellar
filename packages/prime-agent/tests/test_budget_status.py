"""Tests for the read-only ``get_budget_status`` tool.

The tool answers "what may I still spend?" before a purchase or transfer. Its
numbers must agree with the ones ``AgentContext`` puts in the system prompt, it
must be declared read-only, and it must never change anything.
"""

from __future__ import annotations

import re
from decimal import Decimal

import pytest

from talos_agent.agent.context import AgentContext
from talos_agent.config import Settings
from talos_agent.db import LocalDB
from talos_agent.tools import budget
from talos_agent.tools.permissions import (
    LEGACY_TOOL_MANIFESTS,
    NO_GRANTS,
    DataScope,
    EnforcementMode,
    PermissionEnforcer,
    PermissionGrants,
)
from talos_agent.tools.registry import build_all_tools, registry


@pytest.fixture
def env(mock_db: LocalDB, mock_settings: Settings, monkeypatch):
    monkeypatch.setattr(budget, "_db", mock_db)
    monkeypatch.setattr(budget, "_settings", mock_settings)
    return mock_db


def _backdate(db: LocalDB, table: str, row_id: int, days: int) -> None:
    db._conn.execute(
        f"UPDATE {table} SET created_at = datetime('now', ?) WHERE id = ?",
        (f"-{days} days", row_id),
    )
    db._conn.commit()


def _spend(db: LocalDB, amount: float, category: str, days_ago: int = 0) -> None:
    db.record_spending(amount, category, f"{category} spend")
    if days_ago:
        row_id = db._conn.execute("SELECT MAX(id) FROM spending_log").fetchone()[0]
        _backdate(db, "spending_log", row_id, days_ago)


def _seed_mixed(db: LocalDB) -> dict:
    """Mixed categories across today, last week and outside the 30 day window."""
    db.set_talos_config({"id": "t1", "gtmBudget": 120})
    _spend(db, 10.0, "x402_purchase")
    _spend(db, 2.5, "x402_purchase")
    _spend(db, 4.0, "defi_loan")
    _spend(db, 20.0, "x402_purchase", days_ago=5)
    _spend(db, 7.0, "transfer", days_ago=12)
    _spend(db, 500.0, "x402_purchase", days_ago=45)  # outside the month window
    db.cache_approval("a-1", "transaction", "Buy data", None, 30.0)
    db.cache_approval("a-2", "transaction", "Loan", None, 12.5)
    db.cache_approval("a-3", "other", "No amount", None, None)
    db.cache_approval("a-4", "transaction", "Already approved", None, 99.0)
    db.update_approval_status("a-4", "approved")
    db.cache_approval("a-5", "transaction", "Rejected", None, 50.0)
    db.update_approval_status("a-5", "rejected")
    return db.get_talos_config()


# ── Numbers ──────────────────────────────────────────────────────────────────


async def test_spend_by_category_for_today_and_month(env):
    _seed_mixed(env)
    status = await budget.get_budget_status()

    assert status["spending"]["today"]["by_category"] == {
        "x402_purchase": 12.5,
        "defi_loan": 4.0,
    }
    assert status["spending"]["today"]["total"] == 16.5
    assert status["spending"]["month"]["by_category"] == {
        "x402_purchase": 32.5,
        "transfer": 7.0,
        "defi_loan": 4.0,
    }
    assert status["spending"]["month"]["total"] == 43.5
    assert status["spending"]["month"]["window_days"] == 30


async def test_old_spending_is_outside_the_month(env):
    _seed_mixed(env)
    status = await budget.get_budget_status()
    assert 500.0 not in status["spending"]["month"]["by_category"].values()
    assert status["spending"]["month"]["total"] == pytest.approx(43.5)


async def test_gtm_budget_remaining(env):
    _seed_mixed(env)
    gtm = (await budget.get_budget_status())["gtm_budget"]

    assert gtm["monthly"] == 120.0
    assert gtm["source"] == "talos_config"
    assert gtm["spent_this_month"] == 43.5
    assert gtm["remaining"] == pytest.approx(76.5)
    assert gtm["over_budget"] is False


async def test_pending_approvals_count_only_pending(env):
    _seed_mixed(env)
    pending = (await budget.get_budget_status())["pending_approvals"]

    assert pending["count"] == 3
    assert pending["total"] == pytest.approx(42.5)  # 30 + 12.5; approved and rejected excluded
    assert pending["without_amount"] == 1


async def test_remaining_after_pending(env):
    _seed_mixed(env)
    gtm = (await budget.get_budget_status())["gtm_budget"]
    assert gtm["remaining_after_pending"] == pytest.approx(76.5 - 42.5)


async def test_decided_approvals_leave_the_pending_total(env):
    _seed_mixed(env)
    env.update_approval_status("a-1", "approved")
    pending = (await budget.get_budget_status())["pending_approvals"]
    assert pending["count"] == 2
    assert pending["total"] == pytest.approx(12.5)


async def test_approval_threshold_comes_from_settings(env, mock_settings, monkeypatch):
    assert (await budget.get_budget_status())["approval_threshold"] == 10.0

    custom = mock_settings.model_copy(update={"approval_threshold": Decimal("25.5")})
    monkeypatch.setattr(budget, "_settings", custom)
    assert (await budget.get_budget_status())["approval_threshold"] == 25.5


async def test_over_budget_is_reported_not_hidden(env):
    env.set_talos_config({"gtmBudget": 30})
    _spend(env, 50.0, "x402_purchase")
    gtm = (await budget.get_budget_status())["gtm_budget"]

    assert gtm["remaining"] == -20.0
    assert gtm["over_budget"] is True


async def test_empty_database(env):
    status = await budget.get_budget_status()

    assert status["spending"]["today"] == {"total": 0.0, "by_category": {}}
    assert status["spending"]["month"]["by_category"] == {}
    assert status["pending_approvals"] == {"count": 0, "total": 0.0, "without_amount": 0}
    assert status["gtm_budget"]["monthly"] == 200.0
    assert status["gtm_budget"]["source"] == "default"
    assert status["gtm_budget"]["remaining"] == 200.0
    assert status["currency"] == "USDC"


@pytest.mark.parametrize("bad", ["lots", None, [], {}])
async def test_unusable_gtm_budget_falls_back_to_the_default(env, bad):
    env.set_talos_config({"gtmBudget": bad})
    gtm = (await budget.get_budget_status())["gtm_budget"]

    assert gtm["monthly"] == 200.0
    assert gtm["source"] == "default"


async def test_numeric_string_gtm_budget_is_accepted(env):
    env.set_talos_config({"gtmBudget": "75.5"})
    gtm = (await budget.get_budget_status())["gtm_budget"]
    assert gtm["monthly"] == 75.5
    assert gtm["source"] == "talos_config"


async def test_category_totals_add_up_to_the_total(env):
    _seed_mixed(env)
    spending = (await budget.get_budget_status())["spending"]
    for window in ("today", "month"):
        assert sum(spending[window]["by_category"].values()) == pytest.approx(
            spending[window]["total"]
        )


# ── Consistency with AgentContext ────────────────────────────────────────────


async def test_numbers_match_agent_context(env):
    config = _seed_mixed(env)
    status = await budget.get_budget_status()
    context = AgentContext.from_db(env, config)

    assert status["spending"]["today"]["total"] == context.spending_today
    assert status["spending"]["month"]["total"] == context.spending_month
    assert status["gtm_budget"]["monthly"] == context.gtm_budget
    assert status["gtm_budget"]["remaining"] == context.gtm_budget - context.spending_month
    assert status["pending_approvals"]["count"] == context.pending_approvals


async def test_numbers_match_the_context_block_the_model_sees(env):
    config = _seed_mixed(env)
    status = await budget.get_budget_status()
    block = AgentContext.from_db(env, config).to_context_block()

    line = next(line for line in block.splitlines() if line.startswith("GTM Budget"))
    amounts = [float(x) for x in re.findall(r"\$(-?\d+\.\d+)", line)]
    monthly, today, month, remaining = amounts

    assert monthly == pytest.approx(status["gtm_budget"]["monthly"], abs=0.005)
    assert today == pytest.approx(status["spending"]["today"]["total"], abs=0.005)
    assert month == pytest.approx(status["spending"]["month"]["total"], abs=0.005)
    assert remaining == pytest.approx(status["gtm_budget"]["remaining"], abs=0.005)


async def test_over_budget_matches_agent_context(env):
    env.set_talos_config({"gtmBudget": 30})
    _spend(env, 50.0, "x402_purchase")
    status = await budget.get_budget_status()
    context = AgentContext.from_db(env, env.get_talos_config())

    assert status["gtm_budget"]["remaining"] == context.gtm_budget - context.spending_month


async def test_matches_the_policy_budget_context(env):
    """The scheduler's policy middleware computes remaining budget the same way."""
    _seed_mixed(env)
    status = await budget.get_budget_status()

    gtm_budget = float(env.get_talos_config().get("gtmBudget", 200))
    spent = float(env.get_spending_period(30))
    assert status["gtm_budget"]["spent_this_month"] == spent
    # The middleware clamps at zero; the tool reports the overspend as a negative.
    assert max(0.0, status["gtm_budget"]["remaining"]) == max(0.0, gtm_budget - spent)


# ── Read-only ────────────────────────────────────────────────────────────────


async def test_tool_changes_nothing(env):
    _seed_mixed(env)
    before_changes = env._conn.total_changes
    before_rows = {
        table: env._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("spending_log", "approval_cache", "activity_log", "talos_config")
    }

    await budget.get_budget_status()
    await budget.get_budget_status()

    assert env._conn.total_changes == before_changes
    assert before_rows == {
        table: env._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in before_rows
    }


def test_manifest_is_declared_read_only():
    tool = registry.get("get_budget_status")
    assert tool is not None

    manifest = registry.permissions.manifest_for("get_budget_status")
    assert manifest.is_read_only()
    assert not manifest.is_privileged()
    assert manifest.capabilities() == frozenset({DataScope.READ_LOCAL.value})
    assert manifest.hosts == ()
    assert not manifest.requires_approval
    manifest.validate("get_budget_status")


def test_manifest_is_declared_inline_not_in_the_frozen_legacy_table():
    assert "get_budget_status" not in LEGACY_TOOL_MANIFESTS
    assert "get_budget_status" not in registry.permissions.undeclared_tools()


def test_tool_takes_no_arguments():
    schema = registry.get("get_budget_status").to_openai_schema()
    function = schema["function"]
    assert function["name"] == "get_budget_status"
    assert function["parameters"]["properties"] == {}
    assert "required" not in function["parameters"]


def test_allowed_with_only_local_read_granted():
    enforcer = PermissionEnforcer(
        grants=PermissionGrants(capabilities=frozenset({DataScope.READ_LOCAL.value})),
        mode=EnforcementMode.ENFORCE,
    )
    enforcer.register("get_budget_status", registry.permissions.manifest_for("get_budget_status"))

    assert enforcer.check("get_budget_status", {}).allowed


def test_denied_when_not_even_local_read_is_granted():
    enforcer = PermissionEnforcer(grants=NO_GRANTS, mode=EnforcementMode.ENFORCE)
    enforcer.register("get_budget_status", registry.permissions.manifest_for("get_budget_status"))

    assert not enforcer.check("get_budget_status", {}).allowed


# ── Wiring ───────────────────────────────────────────────────────────────────


async def test_build_all_tools_wires_the_tool(mock_db: LocalDB, mock_settings: Settings, monkeypatch):
    monkeypatch.setattr(budget, "_db", None)
    monkeypatch.setattr(budget, "_settings", None)
    mock_db.set_talos_config({"gtmBudget": 60})
    _spend(mock_db, 15.0, "x402_purchase")

    built = build_all_tools(object(), mock_db, object(), mock_settings)

    assert built.get("get_budget_status") is not None
    result = await built.get("get_budget_status").fn()
    assert result["gtm_budget"]["remaining"] == 45.0
    assert result["spending"]["today"]["by_category"] == {"x402_purchase": 15.0}


# ── LocalDB queries ──────────────────────────────────────────────────────────


class TestSpendingByCategory:
    def test_empty(self, mock_db: LocalDB):
        assert mock_db.get_spending_by_category_today() == {}
        assert mock_db.get_spending_by_category_period(30) == {}

    def test_groups_and_orders_by_amount_then_name(self, mock_db: LocalDB):
        _spend(mock_db, 5.0, "b")
        _spend(mock_db, 5.0, "a")
        _spend(mock_db, 1.0, "c")
        _spend(mock_db, 2.0, "c")

        assert list(mock_db.get_spending_by_category_today().items()) == [
            ("a", 5.0),
            ("b", 5.0),
            ("c", 3.0),
        ]

    def test_period_window_matches_get_spending_period(self, mock_db: LocalDB):
        _spend(mock_db, 1.0, "a", days_ago=3)
        _spend(mock_db, 2.0, "a", days_ago=9)
        _spend(mock_db, 4.0, "b", days_ago=40)

        for days in (1, 7, 10, 30, 60):
            assert sum(mock_db.get_spending_by_category_period(days).values()) == pytest.approx(
                mock_db.get_spending_period(days)
            )

    def test_today_matches_get_spending_today(self, mock_db: LocalDB):
        _spend(mock_db, 3.0, "a")
        _spend(mock_db, 9.0, "a", days_ago=2)
        assert sum(mock_db.get_spending_by_category_today().values()) == mock_db.get_spending_today()


class TestPendingApprovalTotals:
    def test_empty(self, mock_db: LocalDB):
        assert mock_db.get_pending_approval_totals() == {
            "count": 0,
            "total": 0.0,
            "without_amount": 0,
        }

    def test_same_rows_as_get_pending_approvals(self, mock_db: LocalDB):
        mock_db.cache_approval("1", "t", "a", None, 4.0)
        mock_db.cache_approval("2", "t", "b", None, None)
        mock_db.cache_approval("3", "t", "c", None, 6.0)
        mock_db.update_approval_status("3", "approved")

        totals = mock_db.get_pending_approval_totals()
        assert totals["count"] == len(mock_db.get_pending_approvals()) == 2
        assert totals["total"] == 4.0
        assert totals["without_amount"] == 1
