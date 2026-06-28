"""Tests for scheduler — lock, shutdown, heartbeat, dividend distribution."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from talos_agent.scheduler import run_dividend_distribution


# ── Scheduler core tests ───────────────────────────────────────────────────────

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

    assert execution_log[0].endswith("-start")
    assert execution_log[1].endswith("-end")
    assert execution_log[0][0] == execution_log[1][0]


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


# ── Dividend distribution helper tests ────────────────────────────────────────

def _make_deps(
    *,
    wallet_public_key="GABC123",
    creator_public_key="GCREATOR456",
    usdc_balance=150.0,
    threshold=100.0,
    balance_error=False,
    preview=None,
    distribute_result=None,
):
    """Build mock dependencies for run_dividend_distribution."""
    talos_config = {
        "walletPublicKey": wallet_public_key,
        "creatorPublicKey": creator_public_key,
    }

    settings = MagicMock()
    settings.dividend_usdc_threshold = threshold

    stellar = MagicMock()
    if balance_error:
        stellar.get_token_balance = AsyncMock(return_value={"error": "Horizon timeout"})
    else:
        stellar.get_token_balance = AsyncMock(return_value={"balance": usdc_balance})

    api = MagicMock()
    api.get_distribution_preview = AsyncMock(
        return_value=preview if preview is not None else {
            "distributableAmount": 50.0,
            "breakdown": [{"patron": "GPATRON1", "amount": 50.0}],
        }
    )
    api.distribute_dividends = AsyncMock(
        return_value=distribute_result if distribute_result is not None else {
            "message": "Distribution complete",
        }
    )

    db = MagicMock()
    db.update_schedule = MagicMock()

    return talos_config, settings, stellar, api, db


@pytest.mark.asyncio
async def test_dividend_missing_wallet_returns_no_wallet():
    """Missing walletPublicKey should return 'no_wallet' without calling API."""
    talos_config, settings, stellar, api, db = _make_deps(wallet_public_key="")

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "no_wallet"
    stellar.get_token_balance.assert_not_called()
    api.get_distribution_preview.assert_not_called()
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_below_threshold_skips_distribution():
    """Balance below threshold should return 'below_threshold' without distributing."""
    talos_config, settings, stellar, api, db = _make_deps(usdc_balance=50.0, threshold=100.0)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "below_threshold"
    api.get_distribution_preview.assert_not_called()
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_horizon_failure_returns_balance_error():
    """Horizon API error should return 'balance_error' and advance schedule."""
    talos_config, settings, stellar, api, db = _make_deps(balance_error=True)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "balance_error"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_called_once_with("dividend_distribution")


@pytest.mark.asyncio
async def test_dividend_preview_failure_aborts_distribution():
    """Failed preview should return 'preview_failed' without calling distribute."""
    talos_config, settings, stellar, api, db = _make_deps(
        preview={"error": "No patrons found"}
    )

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "preview_failed"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_none_preview_aborts_distribution():
    """None preview response should return 'preview_failed' without calling distribute."""
    talos_config, settings, stellar, api, db = _make_deps(preview=False)

    # Force None from the mock
    stellar2 = MagicMock()
    stellar2.get_token_balance = AsyncMock(return_value={"balance": 150.0})
    api.get_distribution_preview = AsyncMock(return_value=None)

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar2,
        api=api,
        db=db,
    )

    assert result == "preview_failed"
    api.distribute_dividends.assert_not_called()
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_distribute_failure_returns_distribution_failed():
    """Failed distribute call should return 'distribution_failed' without updating schedule."""
    talos_config, settings, stellar, api, db = _make_deps(
        distribute_result={"error": "Unauthorized"}
    )

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "distribution_failed"
    db.update_schedule.assert_not_called()


@pytest.mark.asyncio
async def test_dividend_success_updates_schedule():
    """Successful distribution should return 'success' and update the schedule."""
    talos_config, settings, stellar, api, db = _make_deps()

    result = await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    assert result == "success"
    api.distribute_dividends.assert_called_once_with(
        "talos-1", requester_public_key="GCREATOR456"
    )
    db.update_schedule.assert_called_once_with("dividend_distribution")


@pytest.mark.asyncio
async def test_dividend_uses_creator_public_key_not_wallet():
    """distribute_dividends must be called with creatorPublicKey, not walletPublicKey."""
    talos_config, settings, stellar, api, db = _make_deps(
        wallet_public_key="GWALLET999",
        creator_public_key="GCREATOR456",
    )

    await run_dividend_distribution(
        talos_id="talos-1",
        talos_config=talos_config,
        settings=settings,
        stellar=stellar,
        api=api,
        db=db,
    )

    call_kwargs = api.distribute_dividends.call_args
    assert call_kwargs.kwargs["requester_public_key"] == "GCREATOR456"
    assert call_kwargs.kwargs["requester_public_key"] != "GWALLET999"

    @pytest.mark.asyncio
    async def test_dividend_missing_creator_aborts_before_distribute():
        """Missing creatorPublicKey should abort before distribute_dividends is called."""
        talos_config, settings, stellar, api, db = _make_deps(creator_public_key="")

        result = await run_dividend_distribution(
            talos_id="talos-1",
            talos_config=talos_config,
            settings=settings,
            stellar=stellar,
            api=api,
            db=db,
        )

        assert result == "missing_creator"
        api.distribute_dividends.assert_not_called()
        db.update_schedule.assert_not_called()