"""Direct unit tests for the publishing tool layer.

Covers publish_content, reply_on_channel, get_channel_mentions,
search_channel, and get_publishing_channels with success and error
branches, including the _adapter_registry is None path and timeouts.

Uses a FakeAdapter/FakeRegistry fixture — no network or browser.

Issue #875.
"""

from __future__ import annotations

import asyncio

import pytest
from unittest.mock import patch

from talos_agent.adapters.base import ChannelCapabilities, PublishResult
from talos_agent.tools import publishing


# ══════════════════════════════════════════════════════════════════════════════
# Fake fixtures
# ══════════════════════════════════════════════════════════════════════════════


class FakeAdapter:
    """Minimal fake social adapter for testing publishing tools."""

    def __init__(
        self,
        channel_name: str = "X",
        char_limit: int | None = 280,
        supports_replies: bool = True,
        supports_search: bool = True,
        post_result: PublishResult | None = None,
        reply_result: PublishResult | None = None,
        mentions: list[dict] | None = None,
        search_results: list[dict] | None = None,
        validate_error: str | None = None,
        post_exception: Exception | None = None,
        post_delay: float = 0.0,
    ) -> None:
        self.channel_name = channel_name
        self._caps = ChannelCapabilities(
            char_limit=char_limit,
            supports_replies=supports_replies,
            supports_search=supports_search,
        )
        self._post_result = post_result
        self._reply_result = reply_result
        self._mentions = mentions if mentions is not None else []
        self._search_results = search_results if search_results is not None else []
        self._validate_error = validate_error
        self._post_exception = post_exception
        self._post_delay = post_delay

    def get_capabilities(self) -> ChannelCapabilities:
        return self._caps

    def validate_content(self, content: str) -> tuple[bool, str | None]:
        if self._validate_error is not None:
            return False, self._validate_error
        if self._caps.char_limit and len(content) > self._caps.char_limit:
            return (
                False,
                f"Content is {len(content)} chars — exceeds the "
                f"{self._caps.char_limit} character limit for {self.channel_name}.",
            )
        return True, None

    async def post(self, content: str, **kwargs) -> PublishResult:
        if self._post_delay:
            await asyncio.sleep(self._post_delay)
        if self._post_exception:
            raise self._post_exception
        if self._post_result:
            return self._post_result
        return PublishResult(
            status="posted",
            channel=self.channel_name,
            content=content,
            post_id="post-123",
            url="https://example.com/post-123",
        )

    async def reply(self, target_url: str, content: str, **kwargs) -> PublishResult:
        if self._reply_result:
            return self._reply_result
        return PublishResult(
            status="posted",
            channel=self.channel_name,
            content=content,
            post_id="reply-456",
            url=target_url,
        )

    async def get_mentions(self, **kwargs) -> list[dict]:
        return self._mentions

    async def search(self, query: str, **kwargs) -> list[dict]:
        return self._search_results


class FakeRegistry:
    """Fake adapter registry that routes channel names to FakeAdapters."""

    def __init__(self, adapters: dict[str, FakeAdapter] | None = None) -> None:
        self._adapters = adapters or {}

    def get(self, channel: str) -> FakeAdapter | None:
        return self._adapters.get(channel.lower())

    def available_channels(self) -> list[str]:
        return [a.channel_name for a in self._adapters.values()]

    def capabilities(self) -> dict[str, dict]:
        return {
            a.channel_name: a.get_capabilities().__dict__
            for a in self._adapters.values()
        }


def _make_registry(**adapters: FakeAdapter) -> FakeRegistry:
    """Build a FakeRegistry from keyword channel→adapter mappings."""
    return FakeRegistry({name.lower(): adapter for name, adapter in adapters.items()})


# ══════════════════════════════════════════════════════════════════════════════
# publish_content
# ══════════════════════════════════════════════════════════════════════════════


class TestPublishContent:
    """Tests for the publish_content tool."""

    @pytest.mark.asyncio
    async def test_success(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello world", channel="X")
        assert result["status"] == "posted"
        assert result["channel"] == "X"
        assert result["content"] == "Hello world"
        assert result["post_id"] == "post-123"

    @pytest.mark.asyncio
    async def test_success_with_custom_result(self):
        custom = PublishResult(
            status="posted",
            channel="X",
            content="Custom",
            post_id="abc",
            url="https://x.com/abc",
        )
        adapter = FakeAdapter(channel_name="X", post_result=custom)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Custom", channel="X")
        assert result["post_id"] == "abc"
        assert result["url"] == "https://x.com/abc"

    @pytest.mark.asyncio
    async def test_unknown_channel(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello", channel="LinkedIn")
        assert "error" in result
        assert "LinkedIn" in result["error"]
        assert result["available_channels"] == ["X"]

    @pytest.mark.asyncio
    async def test_validate_content_failure(self):
        adapter = FakeAdapter(channel_name="X", char_limit=10)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content(
                "This is way too long", channel="X"
            )
        assert "error" in result
        assert "exceeds" in result["error"]

    @pytest.mark.asyncio
    async def test_validate_content_custom_error(self):
        adapter = FakeAdapter(
            channel_name="X",
            validate_error="Content contains banned keyword",
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello", channel="X")
        assert result["error"] == "Content contains banned keyword"

    @pytest.mark.asyncio
    async def test_adapter_post_exception(self):
        adapter = FakeAdapter(
            channel_name="X",
            post_exception=RuntimeError("network down"),
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello", channel="X")
        assert "error" in result
        assert "RuntimeError" in result["error"]
        assert "network down" in result["error"]

    @pytest.mark.asyncio
    async def test_operation_id_forwarded(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            await publishing.publish_content("Hello", channel="X", operation_id="op-1")
        # The fake adapter's post accepts **kwargs; if it didn't, we'd get a
        # TypeError caught by _publish_safe. Reaching here means it worked.

    @pytest.mark.asyncio
    async def test_default_channel_is_x(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello")
        assert result["status"] == "posted"


# ══════════════════════════════════════════════════════════════════════════════
# reply_on_channel
# ══════════════════════════════════════════════════════════════════════════════


class TestReplyOnChannel:
    """Tests for the reply_on_channel tool."""

    @pytest.mark.asyncio
    async def test_success(self):
        adapter = FakeAdapter(channel_name="X", supports_replies=True)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.reply_on_channel(
                channel="X",
                target_url="https://x.com/post/123",
                content="Nice post!",
            )
        assert result["status"] == "posted"
        assert result["content"] == "Nice post!"
        assert result["url"] == "https://x.com/post/123"

    @pytest.mark.asyncio
    async def test_unknown_channel(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.reply_on_channel(
                channel="Mastodon",
                target_url="https://m.social/@user/123",
                content="Reply",
            )
        assert "error" in result
        assert "Mastodon" in result["error"]

    @pytest.mark.asyncio
    async def test_channel_does_not_support_replies(self):
        adapter = FakeAdapter(channel_name="Telegram", supports_replies=False)
        registry = _make_registry(Telegram=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.reply_on_channel(
                channel="Telegram",
                target_url="https://t.me/channel/123",
                content="Reply",
            )
        assert "error" in result
        assert "does not support replies" in result["error"]

    @pytest.mark.asyncio
    async def test_validate_content_failure(self):
        adapter = FakeAdapter(channel_name="X", char_limit=5, supports_replies=True)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.reply_on_channel(
                channel="X",
                target_url="https://x.com/post/123",
                content="This is too long",
            )
        assert "error" in result
        assert "exceeds" in result["error"]

    @pytest.mark.asyncio
    async def test_custom_validate_error(self):
        adapter = FakeAdapter(
            channel_name="X",
            supports_replies=True,
            validate_error="Reply content is empty",
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.reply_on_channel(
                channel="X",
                target_url="https://x.com/post/123",
                content="",
            )
        assert result["error"] == "Reply content is empty"


# ══════════════════════════════════════════════════════════════════════════════
# get_channel_mentions
# ══════════════════════════════════════════════════════════════════════════════


class TestGetChannelMentions:
    """Tests for the get_channel_mentions tool."""

    @pytest.mark.asyncio
    async def test_success(self):
        mentions = [
            {"id": "m1", "text": "@bot hello"},
            {"id": "m2", "text": "@bot world"},
        ]
        adapter = FakeAdapter(channel_name="X", mentions=mentions)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_channel_mentions(channel="X")
        assert result["channel"] == "X"
        assert result["mentions"] == mentions

    @pytest.mark.asyncio
    async def test_success_empty_mentions(self):
        adapter = FakeAdapter(channel_name="X", mentions=[])
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_channel_mentions(channel="X")
        assert result["channel"] == "X"
        assert result["mentions"] == []

    @pytest.mark.asyncio
    async def test_unknown_channel(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_channel_mentions(channel="Bluesky")
        assert "error" in result
        assert "Bluesky" in result["error"]

    @pytest.mark.asyncio
    async def test_default_channel_is_x(self):
        mentions = [{"id": "m1", "text": "hi"}]
        adapter = FakeAdapter(channel_name="X", mentions=mentions)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_channel_mentions()
        assert result["channel"] == "X"


# ══════════════════════════════════════════════════════════════════════════════
# search_channel
# ══════════════════════════════════════════════════════════════════════════════


class TestSearchChannel:
    """Tests for the search_channel tool."""

    @pytest.mark.asyncio
    async def test_success(self):
        results = [
            {"id": "p1", "text": "Stellar is great"},
            {"id": "p2", "text": "USDC payments"},
        ]
        adapter = FakeAdapter(
            channel_name="X", supports_search=True, search_results=results
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.search_channel("Stellar", channel="X")
        assert result["channel"] == "X"
        assert result["query"] == "Stellar"
        assert result["results"] == results

    @pytest.mark.asyncio
    async def test_unknown_channel(self):
        adapter = FakeAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.search_channel("test", channel="Nope")
        assert "error" in result
        assert "Nope" in result["error"]

    @pytest.mark.asyncio
    async def test_channel_does_not_support_search(self):
        adapter = FakeAdapter(channel_name="Telegram", supports_search=False)
        registry = _make_registry(Telegram=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.search_channel("test", channel="Telegram")
        assert "error" in result
        assert "does not support search" in result["error"]

    @pytest.mark.asyncio
    async def test_default_channel_is_x(self):
        adapter = FakeAdapter(channel_name="X", supports_search=True)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.search_channel("query")
        assert result["channel"] == "X"
        assert result["query"] == "query"


# ══════════════════════════════════════════════════════════════════════════════
# get_publishing_channels
# ══════════════════════════════════════════════════════════════════════════════


class TestGetPublishingChannels:
    """Tests for the get_publishing_channels tool."""

    @pytest.mark.asyncio
    async def test_success(self):
        x_adapter = FakeAdapter(channel_name="X", char_limit=280)
        tg_adapter = FakeAdapter(
            channel_name="Telegram", char_limit=4096, supports_search=False
        )
        registry = _make_registry(X=x_adapter, Telegram=tg_adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_publishing_channels()
        assert "X" in result["available"]
        assert "Telegram" in result["available"]
        assert "X" in result["channels"]
        assert "Telegram" in result["channels"]
        assert result["channels"]["X"]["char_limit"] == 280
        assert result["channels"]["Telegram"]["char_limit"] == 4096

    @pytest.mark.asyncio
    async def test_success_empty_registry(self):
        registry = FakeRegistry()
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_publishing_channels()
        assert result["available"] == []
        assert result["channels"] == {}


# ══════════════════════════════════════════════════════════════════════════════
# _adapter_registry is None
# ══════════════════════════════════════════════════════════════════════════════


class TestRegistryNotInitialized:
    """All tools must return a clear error when the registry is not set."""

    @pytest.mark.asyncio
    async def test_publish_content_registry_none(self):
        with patch.object(publishing, "_adapter_registry", None):
            result = await publishing.publish_content("Hello", channel="X")
        assert result == {"error": "Adapter registry not initialized"}

    @pytest.mark.asyncio
    async def test_reply_on_channel_registry_none(self):
        with patch.object(publishing, "_adapter_registry", None):
            result = await publishing.reply_on_channel(
                channel="X",
                target_url="https://x.com/1",
                content="reply",
            )
        assert result == {"error": "Adapter registry not initialized"}

    @pytest.mark.asyncio
    async def test_get_channel_mentions_registry_none(self):
        with patch.object(publishing, "_adapter_registry", None):
            result = await publishing.get_channel_mentions(channel="X")
        assert result == {"error": "Adapter registry not initialized"}

    @pytest.mark.asyncio
    async def test_search_channel_registry_none(self):
        with patch.object(publishing, "_adapter_registry", None):
            result = await publishing.search_channel("query", channel="X")
        assert result == {"error": "Adapter registry not initialized"}

    @pytest.mark.asyncio
    async def test_get_publishing_channels_registry_none(self):
        with patch.object(publishing, "_adapter_registry", None):
            result = await publishing.get_publishing_channels()
        assert result == {"error": "Adapter registry not initialized"}


# ══════════════════════════════════════════════════════════════════════════════
# Timeout
# ══════════════════════════════════════════════════════════════════════════════


class TestPublishTimeout:
    """The _publish_safe wrapper must catch timeouts and return a structured error."""

    @pytest.mark.asyncio
    async def test_publish_content_timeout(self):
        adapter = FakeAdapter(channel_name="X", post_delay=0.2)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry), \
                patch.object(publishing, "_TIMEOUT", 0.01):
            result = await publishing.publish_content("Hello", channel="X")
        assert "error" in result
        assert "timed out" in result["error"]

    @pytest.mark.asyncio
    async def test_timeout_message_includes_timeout_value(self):
        adapter = FakeAdapter(channel_name="X", post_delay=0.2)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry), \
                patch.object(publishing, "_TIMEOUT", 5):
            result = await publishing.publish_content("Hello", channel="X")
        assert "error" in result
        assert "5s" in result["error"]


# ══════════════════════════════════════════════════════════════════════════════
# Exception handling (_publish_safe wrapper)
# ══════════════════════════════════════════════════════════════════════════════


class TestExceptionHandling:
    """The _publish_safe wrapper must catch exceptions and return structured errors."""

    @pytest.mark.asyncio
    async def test_value_error_wrapped(self):
        adapter = FakeAdapter(
            channel_name="X",
            post_exception=ValueError("invalid content"),
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello", channel="X")
        assert "error" in result
        assert "ValueError" in result["error"]
        assert "invalid content" in result["error"]

    @pytest.mark.asyncio
    async def test_type_error_wrapped(self):
        adapter = FakeAdapter(
            channel_name="X",
            post_exception=TypeError("wrong type"),
        )
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.publish_content("Hello", channel="X")
        assert "error" in result
        assert "TypeError" in result["error"]

    @pytest.mark.asyncio
    async def test_get_mentions_exception_wrapped(self):
        class ExplodingAdapter(FakeAdapter):
            async def get_mentions(self, **kwargs):
                raise ConnectionError("API unavailable")

        adapter = ExplodingAdapter(channel_name="X")
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.get_channel_mentions(channel="X")
        assert "error" in result
        assert "ConnectionError" in result["error"]
        assert "API unavailable" in result["error"]

    @pytest.mark.asyncio
    async def test_search_exception_wrapped(self):
        class ExplodingAdapter(FakeAdapter):
            async def search(self, query, **kwargs):
                raise RuntimeError("search backend down")

        adapter = ExplodingAdapter(channel_name="X", supports_search=True)
        registry = _make_registry(X=adapter)
        with patch.object(publishing, "_adapter_registry", registry):
            result = await publishing.search_channel("test", channel="X")
        assert "error" in result
        assert "RuntimeError" in result["error"]
