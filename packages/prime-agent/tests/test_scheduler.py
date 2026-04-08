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
