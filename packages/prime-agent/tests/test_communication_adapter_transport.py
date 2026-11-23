"""Contract tests for local fake HTTP transport with communication adapters."""

from __future__ import annotations

import asyncio
from collections import deque

import httpx
import pytest

from talos_agent.adapters import AdapterHTTPClient, AdapterRegistry
from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig


class FakeAdapterHTTPClient:
    """Scripted transport: every request consumes one fixture and never uses a network."""

    def __init__(self, *responses: httpx.Response | Exception) -> None:
        self.calls: list[dict] = []
        self._responses = deque(responses)

    async def get(self, url: str, **kwargs) -> httpx.Response:
        return await self._request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs) -> httpx.Response:
        return await self._request("POST", url, **kwargs)

    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        self.calls.append({"method": method, "url": url, **kwargs})
        if not self._responses:
            raise AssertionError(f"unconfigured fake HTTP request: {method} {url}")
        response = self._responses.popleft()
        if isinstance(response, Exception):
            raise response
        return response


def _adapter(http: AdapterHTTPClient, *, max_attempts: int = 0) -> DiscordAdapter:
    return DiscordAdapter(
        DiscordAdapterConfig(
            legacy_webhook_url="https://discord.invalid/api/webhooks/fake/fake",
            reconnect_enabled=max_attempts > 0,
            reconnect_max_attempts=max_attempts,
            reconnect_backoff_initial=0.25,
            reconnect_backoff_max=1.0,
        ),
        http=http,
    )


def _ok_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={"id": "fake-message-id", "channel_id": "fake-channel"},
    )


@pytest.mark.asyncio
async def test_registered_adapter_publishes_through_local_fake():
    http = FakeAdapterHTTPClient(_ok_response())
    registry = AdapterRegistry()
    registry.register(_adapter(http))

    adapter = registry.get("Discord")
    assert adapter is not None
    result = await adapter.post("Local fixture only")

    assert result.status == "posted"
    assert result.post_id == "fake-message-id"
    assert len(http.calls) == 1
    assert http.calls[0]["method"] == "POST"
    assert http.calls[0]["url"].endswith("?wait=true")
    assert http.calls[0]["json"]["content"] == "Local fixture only"


@pytest.mark.asyncio
async def test_retry_uses_scripted_responses_and_stops_after_success(monkeypatch):
    http = FakeAdapterHTTPClient(httpx.Response(503), _ok_response())
    adapter = _adapter(http, max_attempts=2)
    delays: list[float] = []

    async def record_delay(delay: float) -> None:
        delays.append(delay)

    monkeypatch.setattr("talos_agent.adapters.discord.asyncio.sleep", record_delay)

    result = await adapter.post("Retry fixture")

    assert result.status == "posted"
    assert result.metadata["reconnect_attempts"] == 1
    assert len(http.calls) == 2
    assert delays == [0.25]


@pytest.mark.asyncio
async def test_retry_exhaustion_uses_exactly_the_configured_attempt_budget(monkeypatch):
    http = FakeAdapterHTTPClient(httpx.Response(503), httpx.Response(503))
    adapter = _adapter(http, max_attempts=1)

    async def no_wait(_delay: float) -> None:
        return None

    monkeypatch.setattr("talos_agent.adapters.discord.asyncio.sleep", no_wait)

    result = await adapter.post("Failure fixture")

    assert result.status == "failed"
    assert "after 2 attempts" in (result.error or "")
    assert len(http.calls) == 2


@pytest.mark.asyncio
async def test_cancellation_during_retry_does_not_issue_another_publish(monkeypatch):
    http = FakeAdapterHTTPClient(httpx.Response(503))
    registry = AdapterRegistry()
    registry.register(_adapter(http, max_attempts=3))
    adapter = registry.get("Discord")
    assert adapter is not None
    retry_started = asyncio.Event()

    async def wait_for_retry(_delay: float) -> None:
        retry_started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr("talos_agent.adapters.discord.asyncio.sleep", wait_for_retry)

    task = asyncio.create_task(adapter.post("Cancel fixture"))
    await asyncio.wait_for(retry_started.wait(), timeout=1)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(http.calls) == 1
