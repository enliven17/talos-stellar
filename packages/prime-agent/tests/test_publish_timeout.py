"""Tests for configurable publishing tool timeout (Issue #873)."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.config import Settings, safe_config_error
from talos_agent.tools import publishing


class SlowFakeAdapter(BaseSocialAdapter):
    """A fake adapter that sleeps for a configurable duration before returning."""

    channel_name = "Fake"

    def __init__(self, delay: float = 10.0) -> None:
        self._delay = delay
        self._capabilities = ChannelCapabilities(
            char_limit=280,
            supports_replies=True,
            supports_search=True,
        )

    async def post(self, content: str, **kwargs) -> PublishResult:
        await asyncio.sleep(self._delay)
        return PublishResult(status="posted", channel="Fake", content=content, post_id="fake-1")

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        await asyncio.sleep(self._delay)
        return PublishResult(status="posted", channel="Fake", content=content, post_id="fake-reply")

    async def get_mentions(self, **kwargs) -> list[dict]:
        await asyncio.sleep(self._delay)
        return []

    async def search(self, query: str, **kwargs) -> list[dict]:
        await asyncio.sleep(self._delay)
        return []

    async def get_post_performance(self, content_snippet: str, **kwargs) -> dict:
        return {}

    async def get_profile_stats(self, **kwargs) -> dict:
        return {}

    def get_capabilities(self) -> ChannelCapabilities:
        return self._capabilities


def _setup_registry(adapter: BaseSocialAdapter):
    """Inject a fake adapter into the publishing module's registry."""
    from talos_agent.adapters.registry import AdapterRegistry

    registry = AdapterRegistry()
    registry.register(adapter)
    publishing._adapter_registry = registry
    return registry


@pytest.fixture(autouse=True)
def reset_registry():
    """Ensure _adapter_registry is reset between tests."""
    yield
    publishing._adapter_registry = None  # type: ignore[assignment]
    publishing._publish_timeout = publishing._DEFAULT_TIMEOUT


class TestConfigurablePublishTimeout:
    """Verify that the publishing timeout comes from settings and is enforced."""

    def test_timeout_comes_from_settings(self):
        """set_publish_timeout updates the module-level timeout used by _publish_safe."""
        publishing.set_publish_timeout(5)
        assert publishing._publish_timeout == 5

    def test_default_timeout_is_90(self):
        """The module-level default preserves the previous hard-coded 90s."""
        assert publishing._DEFAULT_TIMEOUT == 90

    def test_slow_adapter_times_out_with_small_timeout(self):
        """A slow fake adapter should time out when the timeout is small."""
        adapter = SlowFakeAdapter(delay=5.0)
        _setup_registry(adapter)
        publishing.set_publish_timeout(0.5)

        result = asyncio.run(publishing.publish_content("hello", channel="Fake"))

        assert "error" in result
        assert "timed out" in result["error"]
        assert "0.5" in result["error"]

    def test_slow_adapter_completes_with_large_timeout(self):
        """The same slow adapter succeeds when given enough time."""
        adapter = SlowFakeAdapter(delay=0.1)
        _setup_registry(adapter)
        publishing.set_publish_timeout(5)

        result = asyncio.run(publishing.publish_content("hello", channel="Fake"))

        assert result.get("status") == "posted"
        assert result.get("channel") == "Fake"

    def test_settings_publish_timeout_default_is_90(self):
        """Settings.publish_timeout_seconds defaults to 90 (backward compatible)."""
        settings = Settings(
            talos_api_key="test",
            talos_id="test",
            groq_api_key="test",
        )
        assert settings.publish_timeout_seconds == 90

    def test_settings_publish_timeout_from_env(self, monkeypatch):
        """TALOS_PUBLISH_TIMEOUT env var is respected."""
        monkeypatch.setenv("TALOS_PUBLISH_TIMEOUT", "120")
        settings = Settings(
            talos_api_key="test",
            talos_id="test",
            groq_api_key="test",
        )
        assert settings.publish_timeout_seconds == 120

    def test_settings_invalid_timeout_fails_at_load(self, monkeypatch):
        """Invalid values fail at config load with a redacted error."""
        monkeypatch.setenv("TALOS_PUBLISH_TIMEOUT", "not-a-number")
        with pytest.raises(Exception) as exc_info:
            Settings(
                talos_api_key="test",
                talos_id="test",
                groq_api_key="test",
            )
        message = safe_config_error(exc_info.value)
        assert "not-a-number" not in message

    def test_settings_zero_timeout_rejected(self, monkeypatch):
        """Zero timeout is rejected — timeout must be positive."""
        monkeypatch.setenv("TALOS_PUBLISH_TIMEOUT", "0")
        with pytest.raises(Exception):
            Settings(
                talos_api_key="test",
                talos_id="test",
                groq_api_key="test",
            )

    def test_settings_timeout_over_max_rejected(self, monkeypatch):
        """Timeout exceeding the max (300s) is rejected."""
        monkeypatch.setenv("TALOS_PUBLISH_TIMEOUT", "301")
        with pytest.raises(Exception):
            Settings(
                talos_api_key="test",
                talos_id="test",
                groq_api_key="test",
            )

    def test_reply_on_channel_times_out_with_small_timeout(self):
        """reply_on_channel is also bounded by the configured timeout."""
        adapter = SlowFakeAdapter(delay=5.0)
        _setup_registry(adapter)
        publishing.set_publish_timeout(0.5)

        result = asyncio.run(
            publishing.reply_on_channel(
                channel="Fake",
                target_url="https://example.com/post/1",
                content="reply content",
            )
        )

        assert "error" in result
        assert "timed out" in result["error"]

    def test_get_channel_mentions_times_out_with_small_timeout(self):
        """get_channel_mentions is also bounded by the configured timeout."""
        adapter = SlowFakeAdapter(delay=5.0)
        _setup_registry(adapter)
        publishing.set_publish_timeout(0.5)

        result = asyncio.run(publishing.get_channel_mentions(channel="Fake"))

        assert "error" in result
        assert "timed out" in result["error"]
