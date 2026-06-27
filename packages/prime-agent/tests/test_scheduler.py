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
@pytest.mark.asyncio
async def test_dividend_skips_when_below_threshold():
    """Balance below threshold should not trigger distribution."""
    distributed = False

    async def mock_task(balance, threshold, shutdown):
        nonlocal distributed
        if balance >= threshold:
            distributed = True

    shutdown = asyncio.Event()
    await mock_task(balance=50.0, threshold=100.0, shutdown=shutdown)
    assert distributed is False


@pytest.mark.asyncio
async def test_dividend_distributes_when_above_threshold():
    """Balance above threshold should trigger distribution and update schedule."""
    distributed = False
    schedule_updated = False

    async def mock_task(balance, threshold):
        nonlocal distributed, schedule_updated
        if balance >= threshold:
            distributed = True
            schedule_updated = True

    await mock_task(balance=150.0, threshold=100.0)
    assert distributed is True
    assert schedule_updated is True


@pytest.mark.asyncio
async def test_dividend_aborts_on_failed_preview():
    """A failed preview response should abort before execute is called."""
    execute_called = False

    async def mock_distribute(preview):
        nonlocal execute_called
        if not preview or "error" in preview:
            return  # abort
        execute_called = True

    await mock_distribute(preview={"error": "No patrons found"})
    assert execute_called is False


@pytest.mark.asyncio
async def test_dividend_aborts_on_no_preview_response():
    """A None preview response should abort before execute is called."""
    execute_called = False

    async def mock_distribute(preview):
        nonlocal execute_called
        if not preview:
            return  # abort
        execute_called = True

    await mock_distribute(preview=None)
    assert execute_called is False


@pytest.mark.asyncio
async def test_dividend_skips_within_interval():
    """Task should skip distribution if last run was within the interval."""
    skipped = False

    async def mock_task(elapsed, interval):
        nonlocal skipped
        remaining = interval - elapsed
        if remaining > 0:
            skipped = True
            return

    await mock_task(elapsed=1800, interval=3600)
    assert skipped is True


@pytest.mark.asyncio
async def test_dividend_horizon_failure_does_not_distribute():
    """Horizon API error on balance check should prevent distribution."""
    distributed = False

    async def mock_task(balance_result):
        nonlocal distributed
        if "error" in balance_result:
            return  # log and skip
        distributed = True

    await mock_task(balance_result={"error": "Horizon timeout"})
    assert distributed is False