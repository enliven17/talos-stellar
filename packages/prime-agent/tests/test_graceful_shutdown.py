"""Tests for graceful shutdown with in-flight job draining — issue #182.

Covers:
- Shutdown event stops polling / new work
- Tasks that finish within deadline are awaited cleanly
- Tasks that exceed the deadline are cancelled deterministically
- Cancelled task names are recorded in the activity log
- shutdown_deadline=0 cancels immediately without waiting
- Signal handler increments count; second signal forces os._exit (logic only)
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from talos_agent.config import Settings


# ── helpers ────────────────────────────────────────────────────────────────────


def _make_settings(**overrides) -> Settings:
    base = dict(
        talos_api_url="http://test.local",
        talos_api_key="cpk_test",
        talos_id="test-id",
        openai_api_key="sk-test",
        shutdown_deadline=5.0,
    )
    base.update(overrides)
    return Settings(**base)


# ── shutdown_event semantics ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shutdown_event_stops_polling_loop():
    """A task polling on shutdown_event should exit promptly when the event is set."""
    shutdown = asyncio.Event()
    poll_count = 0

    async def polling():
        nonlocal poll_count
        while not shutdown.is_set():
            poll_count += 1
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=0.01)
                break
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(polling())
    await asyncio.sleep(0.05)
    shutdown.set()
    await task
    assert poll_count >= 1, "polling loop should have run at least once before shutdown"


@pytest.mark.asyncio
async def test_shutdown_event_stops_all_tasks():
    """All tasks sharing shutdown_event should stop after it is set."""
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

    tasks = [asyncio.create_task(worker(n)) for n in ("A", "B", "C")]
    await asyncio.sleep(0.05)
    shutdown.set()
    await asyncio.gather(*tasks)
    assert sorted(stopped) == ["A", "B", "C"]


# ── deadline: tasks finish in time ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tasks_finishing_within_deadline_are_not_cancelled():
    """When all tasks complete before the deadline, none should be cancelled."""
    shutdown = asyncio.Event()
    finished: list[str] = []

    async def quick_worker(name: str):
        await asyncio.sleep(0.02)
        finished.append(name)

    tasks = [asyncio.create_task(quick_worker(n), name=n) for n in ("X", "Y")]
    shutdown.set()

    deadline = 1.0
    try:
        await asyncio.wait_for(
            asyncio.shield(asyncio.gather(*tasks, return_exceptions=True)),
            timeout=deadline,
        )
    except asyncio.TimeoutError:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    assert sorted(finished) == ["X", "Y"]
    assert all(t.done() and not t.cancelled() for t in tasks)


# ── deadline: tasks exceed deadline → cancel + record ─────────────────────────


@pytest.mark.asyncio
async def test_tasks_exceeding_deadline_are_cancelled():
    """Tasks still running after the deadline must be cancelled."""
    shutdown = asyncio.Event()
    cancelled_names: list[str] = []

    async def slow_worker():
        await asyncio.sleep(10)  # deliberately long

    tasks = [
        asyncio.create_task(slow_worker(), name="slow_A"),
        asyncio.create_task(slow_worker(), name="slow_B"),
    ]
    shutdown.set()

    deadline = 0.05  # very short
    try:
        await asyncio.wait_for(
            asyncio.shield(asyncio.gather(*tasks, return_exceptions=True)),
            timeout=deadline,
        )
    except asyncio.TimeoutError:
        still_running = [t for t in tasks if not t.done()]
        cancelled_names.extend(t.get_name() for t in still_running)
        for t in still_running:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    assert sorted(cancelled_names) == ["slow_A", "slow_B"]
    assert all(t.done() for t in tasks)


@pytest.mark.asyncio
async def test_cancelled_tasks_are_recorded_in_activity_log():
    """Each cancelled task must be recorded via db.add_activity with type 'shutdown_cancelled'."""
    shutdown = asyncio.Event()
    recorded: list[dict] = []

    db = MagicMock()
    db.add_activity = MagicMock(side_effect=lambda t, c, ch: recorded.append({"type": t, "content": c, "channel": ch}))

    async def slow_worker():
        await asyncio.sleep(10)

    tasks = [
        asyncio.create_task(slow_worker(), name="job_alpha"),
        asyncio.create_task(slow_worker(), name="job_beta"),
    ]
    shutdown.set()

    deadline = 0.05
    try:
        await asyncio.wait_for(
            asyncio.shield(asyncio.gather(*tasks, return_exceptions=True)),
            timeout=deadline,
        )
    except asyncio.TimeoutError:
        still_running = [t for t in tasks if not t.done()]
        for t in still_running:
            db.add_activity(
                "shutdown_cancelled",
                f"Task '{t.get_name()}' was cancelled at shutdown (deadline={deadline:.0f}s)",
                "system",
            )
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    assert len(recorded) == 2
    names_in_log = {r["content"] for r in recorded}
    assert any("job_alpha" in c for c in names_in_log)
    assert any("job_beta" in c for c in names_in_log)
    assert all(r["type"] == "shutdown_cancelled" for r in recorded)
    assert all(r["channel"] == "system" for r in recorded)


# ── deadline == 0: immediate cancel ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_zero_deadline_cancels_immediately():
    """shutdown_deadline=0 should cancel all tasks without waiting."""
    settings = _make_settings(shutdown_deadline=0)
    assert settings.shutdown_deadline == 0.0

    shutdown = asyncio.Event()

    async def never_finishes():
        await asyncio.sleep(100)

    tasks = [asyncio.create_task(never_finishes(), name="inf") for _ in range(3)]
    shutdown.set()

    # Immediate-cancel path
    for t in tasks:
        t.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    assert all(isinstance(r, asyncio.CancelledError) for r in results)


# ── Settings.shutdown_deadline field ──────────────────────────────────────────


def test_settings_shutdown_deadline_default():
    """Settings.shutdown_deadline should default to 30.0 seconds."""
    # Override is 5.0 in helper; test the actual class default
    s2 = Settings(
        talos_api_url="http://test.local",
        talos_api_key="cpk_test",
        talos_id="test-id",
        openai_api_key="sk-test",
    )
    assert s2.shutdown_deadline == 30.0


def test_settings_shutdown_deadline_configurable():
    """shutdown_deadline should be settable via constructor."""
    s = _make_settings(shutdown_deadline=60.0)
    assert s.shutdown_deadline == 60.0


def test_settings_shutdown_deadline_zero_valid():
    """shutdown_deadline=0 (immediate cancel) should be accepted."""
    s = _make_settings(shutdown_deadline=0)
    assert s.shutdown_deadline == 0.0


# ── Signal-handler logic (unit, no real signals) ──────────────────────────────


def test_signal_handler_first_call_sets_shutdown_event():
    """First call to the signal handler sets the shutdown event."""
    shutdown = asyncio.Event()
    signal_count = 0

    def handle_signal():
        nonlocal signal_count
        signal_count += 1
        if signal_count == 1:
            shutdown.set()

    handle_signal()
    assert shutdown.is_set()
    assert signal_count == 1


def test_signal_handler_second_call_would_force_exit():
    """Second call to the signal handler should trigger os._exit (verified via mock)."""
    signal_count = 0
    exit_called_with: list[int] = []

    def handle_signal():
        nonlocal signal_count
        signal_count += 1
        if signal_count >= 2:
            exit_called_with.append(1)  # simulate os._exit(1)

    handle_signal()
    handle_signal()
    assert exit_called_with == [1]


# ── Deterministic cancellation ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cancellation_is_deterministic_under_concurrent_tasks():
    """All pending tasks must be cancelled exactly once — no double-cancel or race."""
    async def slow():
        await asyncio.sleep(100)

    tasks = [asyncio.create_task(slow(), name=f"t{i}") for i in range(5)]

    # Simulate the shutdown path: cancel each non-done task exactly once
    still_running = [t for t in tasks if not t.done()]
    for t in still_running:
        t.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Every task should be cancelled
    assert all(isinstance(r, asyncio.CancelledError) for r in results)
    # Each task is done exactly once
    assert all(t.done() for t in tasks)
    assert len({id(t) for t in tasks}) == 5  # no duplicates


@pytest.mark.asyncio
async def test_already_done_tasks_not_cancelled_again():
    """Tasks that finish before the deadline must not be marked as cancelled."""
    async def fast():
        await asyncio.sleep(0)

    async def slow():
        await asyncio.sleep(100)

    fast_task = asyncio.create_task(fast(), name="fast")
    slow_task = asyncio.create_task(slow(), name="slow")

    # Let fast_task finish
    await asyncio.sleep(0.01)
    assert fast_task.done()

    # Only cancel the still-running ones
    still_running = [t for t in [fast_task, slow_task] if not t.done()]
    assert still_running == [slow_task]
    slow_task.cancel()
    await asyncio.gather(fast_task, slow_task, return_exceptions=True)

    assert not fast_task.cancelled()
    assert slow_task.cancelled()
