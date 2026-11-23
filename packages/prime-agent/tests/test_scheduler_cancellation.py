"""Tests for issue #1436 — differentiate cancellation from a failed scheduler attempt.

Acceptance criteria verified:
- Intentional shutdown does not consume DurableBackoff retry budget: an attempt
  that fails while ``shutdown_event`` is set, or that is cancelled outright,
  must not persist ``retry_state``.
- Genuine failures still consume retry budget (regression/boundary).
- A cycle terminated by asyncio cancellation is summarised with
  ``outcome="cancelled"`` — not ``"completed"`` or ``"error"``.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.db import LocalDB
from talos_agent.scheduler.tasks import job_effect_dispatch_task, polling_task


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_db() -> LocalDB:
    tmp = tempfile.mktemp(suffix=".db")
    return LocalDB(Path(tmp))


def _make_settings(**overrides: Any) -> MagicMock:
    settings = MagicMock()
    settings.talos_id = "talos-1"
    settings.polling_interval = 0.01
    settings.talos_job_effect_dispatch_interval = 0.01
    for key, value in overrides.items():
        setattr(settings, key, value)
    return settings


# ── Scheduler tasks: shutdown must not consume retry budget ───────────────────


@pytest.mark.asyncio
async def test_polling_error_during_shutdown_does_not_consume_retry_budget():
    """An attempt that errors after shutdown was requested is not a failure."""
    db = _make_db()
    shutdown_event = asyncio.Event()

    async def _fail_after_shutdown(*_args: Any, **_kwargs: Any) -> Any:
        shutdown_event.set()
        raise RuntimeError("api failure during shutdown")

    api = MagicMock()
    api.get_approvals = AsyncMock(side_effect=_fail_after_shutdown)

    try:
        await polling_task(
            shutdown_event=shutdown_event,
            settings=_make_settings(),
            api=api,
            db=db,
            talos_config={},
            job_effect_store=None,
        )

        assert db.get_retry_state("polling") is None
    finally:
        db.close()


@pytest.mark.asyncio
async def test_polling_cancellation_does_not_consume_retry_budget():
    """asyncio.CancelledError inside an attempt propagates without failure()."""
    db = _make_db()
    shutdown_event = asyncio.Event()

    api = MagicMock()
    api.get_approvals = AsyncMock(side_effect=asyncio.CancelledError)

    try:
        with pytest.raises(asyncio.CancelledError):
            await polling_task(
                shutdown_event=shutdown_event,
                settings=_make_settings(),
                api=api,
                db=db,
                talos_config={},
                job_effect_store=None,
            )

        assert db.get_retry_state("polling") is None
    finally:
        db.close()


@pytest.mark.asyncio
async def test_polling_genuine_failure_still_consumes_retry_budget():
    """Boundary: a real failure with no shutdown still records attempt_count."""
    db = _make_db()
    shutdown_event = asyncio.Event()

    api = MagicMock()
    api.get_approvals = AsyncMock(side_effect=RuntimeError("api down"))

    try:
        task = asyncio.create_task(
            polling_task(
                shutdown_event=shutdown_event,
                settings=_make_settings(),
                api=api,
                db=db,
                talos_config={},
                job_effect_store=None,
            )
        )
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        state = db.get_retry_state("polling")
        assert state is not None
        assert state["attempt_count"] >= 1
        assert state["terminal"] is False
    finally:
        db.close()


@pytest.mark.asyncio
async def test_job_effect_dispatch_error_during_shutdown_skips_backoff():
    """The dispatch batch loop applies the same shutdown guard."""
    db = _make_db()
    shutdown_event = asyncio.Event()

    async def _fail_after_shutdown(*_args: Any, **_kwargs: Any) -> Any:
        shutdown_event.set()
        raise RuntimeError("dispatch failure during shutdown")

    dispatcher = MagicMock()
    dispatcher.dispatch_once = AsyncMock(side_effect=_fail_after_shutdown)

    try:
        await job_effect_dispatch_task(
            shutdown_event=shutdown_event,
            settings=_make_settings(),
            db=db,
            job_effect_dispatcher=dispatcher,
        )

        assert db.get_retry_state("job_effect_dispatch") is None
    finally:
        db.close()


# ── Cycle summaries: cancellation is terminal, not "completed" ────────────────


@pytest.mark.asyncio
async def test_agent_loop_cancelled_cycle_summary_outcome():
    """A cancelled agent cycle must persist outcome='cancelled'."""
    from talos_agent.agent.context import AgentContext
    from talos_agent.agent.loop import agent_loop
    from talos_agent.config import Settings

    db = _make_db()
    try:
        settings = Settings(
            talos_api_url="http://test.local",
            talos_api_key="cpk_test",
            talos_id="agent-cancel",
            openai_api_key="sk-test",
            max_iterations=5,
        )
        talos_config = {"id": "agent-cancel"}
        context = AgentContext.from_db(db, talos_config)
        tools = MagicMock()
        tools.openai_schemas.return_value = []

        with patch("talos_agent.agent.loop.call_with_retry") as mock_retry:
            mock_retry.side_effect = asyncio.CancelledError

            with pytest.raises(asyncio.CancelledError):
                await agent_loop(
                    settings=settings,
                    tools=tools,
                    talos_config=talos_config,
                    context=context,
                    db=db,
                    system_prompt_override="test prompt",
                )

        summaries = db.get_recent_cycle_summaries(talos_id="agent-cancel")
        assert len(summaries) == 1
        s = summaries[0]
        assert s["outcome"] == "cancelled"
        assert s["error_type"] == "CancelledError"
        assert s["error_category"] == "cancelled"
    finally:
        db.close()
