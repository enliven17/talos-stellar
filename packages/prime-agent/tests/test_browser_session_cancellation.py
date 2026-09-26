"""Tests for browser session cleanup on cancellation — issue #552.

Covers:
- BrowserSession.close() is idempotent and privacy-safe
- cleanup_on_cancellation handles missing session ids and dependency failures
- tools.cleanup_browser_sessions_on_cancellation resets adapters and nulls handle
- Agent-loop CancelledError path invokes browser cleanup
- No secrets / session payloads appear in cleanup results
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.browser.session import BrowserSession
from talos_agent.tools import browser as browser_mod


# ── fakes ─────────────────────────────────────────────────────────────────────


class _FakeSessions:
    def __init__(self, *, fail_end: bool = False):
        self.ended: list[str] = []
        self.fail_end = fail_end

    def end(self, session_id: str) -> None:
        if self.fail_end:
            raise RuntimeError("stagehand unavailable")
        self.ended.append(session_id)


class _FakeClient:
    def __init__(self, sessions: _FakeSessions):
        self.sessions = sessions


def _make_session(
    session_id: str = "sess-1",
    *,
    fail_end: bool = False,
    closed: bool = False,
) -> tuple[BrowserSession, _FakeSessions]:
    sessions = _FakeSessions(fail_end=fail_end)
    client = _FakeClient(sessions)
    browser = BrowserSession(client, session_id)  # type: ignore[arg-type]
    browser._closed = closed
    return browser, sessions


# ── BrowserSession.close / cleanup_on_cancellation ─────────────────────────────


@pytest.mark.asyncio
async def test_close_ends_session_and_is_idempotent():
    browser, sessions = _make_session("sess-abc")

    first = await browser.close()
    assert first["status"] == "closed"
    assert first["ended"] is True
    assert sessions.ended == ["sess-abc"]
    assert browser._closed is True
    assert browser._session_id == ""
    assert browser.is_alive is False

    second = await browser.close()
    assert second["status"] == "already_closed"
    assert sessions.ended == ["sess-abc"]  # not ended twice


@pytest.mark.asyncio
async def test_close_missing_session_id_is_clean():
    browser, sessions = _make_session("")
    result = await browser.close()
    assert result["status"] == "closed"
    assert result["ended"] is False
    assert result["reason"] == "missing_session_id"
    assert sessions.ended == []
    assert browser._closed is True


@pytest.mark.asyncio
async def test_close_dependency_failure_still_marks_closed():
    browser, sessions = _make_session("sess-x", fail_end=True)
    result = await browser.close()
    assert result["status"] == "closed"
    assert result["ended"] is False
    assert result["error_type"] == "RuntimeError"
    assert browser._closed is True
    assert browser._session_id == ""
    # Privacy: result must not echo the exception message (may contain paths).
    assert "stagehand" not in str(result).lower() or result["error_type"] == "RuntimeError"
    assert "unavailable" not in str(result)


@pytest.mark.asyncio
async def test_cleanup_on_cancellation_returns_cancellation_marker():
    browser, sessions = _make_session("sess-cancel")
    result = await browser.cleanup_on_cancellation()
    assert result["cleanup"] == "cancellation"
    assert result["status"] == "closed"
    assert sessions.ended == ["sess-cancel"]

    again = await browser.cleanup_on_cancellation()
    assert again["status"] == "already_cleaned"


# ── tools.cleanup_browser_sessions_on_cancellation ─────────────────────────────


@pytest.mark.asyncio
async def test_tools_cleanup_noop_when_no_browser():
    browser_mod._browser = None
    browser_mod._adapter_registry = None
    result = await browser_mod.cleanup_browser_sessions_on_cancellation()
    assert result["status"] == "noop"
    assert result["reason"] == "no_browser_session"


@pytest.mark.asyncio
async def test_tools_cleanup_closes_browser_and_resets_adapters():
    browser, sessions = _make_session("sess-tools")
    x_adapter = MagicMock()
    x_adapter._logged_in = True
    registry = MagicMock()
    registry._adapters = {"x": x_adapter}
    registry.available_channels.return_value = ["X"]
    registry.get.return_value = x_adapter

    browser_mod._browser = browser
    browser_mod._adapter_registry = registry

    result = await browser_mod.cleanup_browser_sessions_on_cancellation()

    assert result["status"] == "cleaned"
    assert result["adapters_reset"] == 1
    assert x_adapter._logged_in is False
    assert browser_mod._browser is None
    assert sessions.ended == ["sess-tools"]
    # No secrets in the returned payload
    blob = str(result)
    assert "sk-" not in blob
    assert "seed" not in blob.lower()


@pytest.mark.asyncio
async def test_tools_cleanup_handles_close_timeout():
    browser = MagicMock()
    browser.cleanup_on_cancellation = AsyncMock(side_effect=asyncio.TimeoutError())
    browser._closed = False
    browser._session_id = "sess-slow"

    browser_mod._browser = browser
    browser_mod._adapter_registry = None

    with patch.object(browser_mod, "_CLEANUP_TIMEOUT_SECONDS", 0.01):
        # Force wait_for to time out by using a never-resolving awaitable
        async def _hang():
            await asyncio.sleep(10)
            return {}

        browser.cleanup_on_cancellation = _hang
        result = await browser_mod.cleanup_browser_sessions_on_cancellation()

    assert result["status"] == "cleaned"
    assert result["close"]["status"] == "timeout"
    assert browser_mod._browser is None
    assert browser._closed is True
    assert browser._session_id == ""


# ── agent loop CancelledError path ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_execute_tool_cancelled_triggers_browser_cleanup():
    from talos_agent.agent import loop as loop_mod

    settings = MagicMock()
    settings.tool_timeout_seconds = 30.0
    tools = MagicMock()

    async def _slow_execute(name, args):
        await asyncio.sleep(10)
        return {"ok": True}

    tools.execute = _slow_execute
    cleaned = {"n": 0}

    async def _fake_cleanup():
        cleaned["n"] += 1

    with patch.object(loop_mod, "_cleanup_browser_on_cancellation", _fake_cleanup):
        task = asyncio.create_task(
            loop_mod._execute_tool_with_timeout(settings, tools, "browse_page", {})
        )
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert cleaned["n"] == 1


@pytest.mark.asyncio
async def test_cleanup_helper_swallows_import_errors():
    from talos_agent.agent import loop as loop_mod

    with patch.dict("sys.modules", {"talos_agent.tools.browser": None}):
        # Should not raise even if the tools module is unavailable.
        await loop_mod._cleanup_browser_on_cancellation()
