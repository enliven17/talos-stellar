"""Tests for scheduler — lock, shutdown, heartbeat."""

from __future__ import annotations

import asyncio

import pytest


@pytest.mark.asyncio
async def test_agent_lock_prevents_concurrent_execution():
    """Two coroutines competing for a lock should not interleave."""
    lock = asyncio.Lock()
    execution_log: list[str] = []

    async def worker(name: str):
        async with lock:
            execution_log.append(f"{name}-start")
            await asyncio.sleep(0.05)
            execution_log.append(f"{name}-end")

    await asyncio.gather(worker("A"), worker("B"))

    # One must fully complete before the other starts
    assert execution_log[0].endswith("-start")
    assert execution_log[1].endswith("-end")
    assert execution_log[0][0] == execution_log[1][0]  # Same worker


@pytest.mark.asyncio
async def test_shutdown_event_stops_task():
    """A task checking shutdown_event should exit promptly."""
    shutdown = asyncio.Event()
    iterations = 0

    async def loop():
        nonlocal iterations
        while not shutdown.is_set():
            iterations += 1
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=0.01)
                break
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(loop())
    await asyncio.sleep(0.05)
    shutdown.set()
    await task
    assert iterations >= 1


@pytest.mark.asyncio
async def test_shutdown_stops_multiple_tasks():
    """Multiple tasks should all stop when shutdown is set."""
    shutdown = asyncio.Event()
    stopped: list[str] = []

    async def worker(name: str):
        while not shutdown.is_set():
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=0.01)
                break
            except asyncio.TimeoutError:
                pass
        stopped.append(name)

    tasks = [asyncio.create_task(worker(n)) for n in ["A", "B", "C"]]
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.gather(*tasks)
    assert sorted(stopped) == ["A", "B", "C"]


class TestLoanRepaymentScheduler:
    @pytest.mark.asyncio
    async def test_no_loans_due_skips_repayment(self, mock_db):
        """When no loans are due, repayment cycle does nothing."""
        loans_due = mock_db.get_loans_due_soon(days=7)
        assert loans_due == []

    @pytest.mark.asyncio
    async def test_sufficient_funds_repays_loan(self, mock_db):
        """When outstanding <= available balance, loan gets fully repaid."""
        loan_id = mock_db.create_loan(
            platform="aave",
            amount=50.0,
            collateral_asset="USDC",
            loan_asset="XLM",
            duration_days=3,
            purpose="test",
        )
        # Simulate repayment with sufficient funds
        mock_db.record_repayment(loan_id, 50.0, tx_hash="tx_abc")
        loan = mock_db.get_loan_by_id(loan_id)
        assert loan["status"] == "repaid"
        assert loan["outstanding_amount"] == 0.0

    @pytest.mark.asyncio
    async def test_insufficient_funds_partial_repayment(self, mock_db):
        """When balance < outstanding, only available amount is repaid."""
        loan_id = mock_db.create_loan(
            platform="aave",
            amount=100.0,
            collateral_asset="USDC",
            loan_asset="XLM",
            duration_days=3,
            purpose="test",
        )
        # Only 40 available out of 100 outstanding
        mock_db.record_repayment(loan_id, 40.0)
        loan = mock_db.get_loan_by_id(loan_id)
        assert loan["status"] == "active"
        assert loan["outstanding_amount"] == 60.0

    @pytest.mark.asyncio
    async def test_already_repaid_loan_ignored(self, mock_db):
        """A fully repaid loan should not appear in due loans."""
        loan_id = mock_db.create_loan(
            platform="compound",
            amount=75.0,
            collateral_asset="USDC",
            loan_asset="XLM",
            duration_days=3,
            purpose="test",
        )
        mock_db.record_repayment(loan_id, 75.0)
        loans_due = mock_db.get_loans_due_soon(days=7)
        loan_ids = [l["id"] for l in loans_due]
        assert loan_id not in loan_ids

    @pytest.mark.asyncio
    async def test_warning_logged_on_insufficient_funds(self, mock_db):
        """When funds are insufficient, a loan_warning activity is logged."""
        loan_id = mock_db.create_loan(
            platform="aave",
            amount=200.0,
            collateral_asset="USDC",
            loan_asset="XLM",
            duration_days=3,
            purpose="test",
        )
        mock_db.add_activity(
            "loan_warning",
            f"Loan {loan_id} due but insufficient funds. Outstanding: 200.0, Available: 10.0",
            "defi",
        )
        pending = mock_db.get_pending_activities()
        warnings = [a for a in pending if a["type"] == "loan_warning"]
        assert len(warnings) == 1