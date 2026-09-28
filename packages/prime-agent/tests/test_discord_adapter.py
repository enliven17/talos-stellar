"""Tests for the DiscordAdapter — webhook and bot API paths."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import respx
from httpx import Response

from talos_agent.adapters.discord import (
    _COLOR_DEFAULT,
    _COLOR_GTM,
    _COLOR_WARN,
    _DISCORD_API,
    DiscordAdapter,
    DiscordAdapterConfig,
)


def _make_settings(
    webhook_url: str = "",
    bot_token: str = "",
    channel_id: str = "",
    guild_id: str = "",
) -> MagicMock:
    s = MagicMock()
    s.discord_webhook_url = webhook_url
    s.discord_bot_token = bot_token
    s.discord_channel_id = channel_id
    s.discord_guild_id = guild_id
    return s


# ── Capabilities ─────────────────────────────────────────────────────────────

class TestCapabilities:
    def test_full_caps_with_bot_credentials(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="123"))
        caps = adapter.get_capabilities()
        assert caps.char_limit == 2000
        assert caps.supports_replies is True
        assert caps.supports_mentions is True
        assert caps.supports_analytics is True

    def test_limited_caps_webhook_only(self):
        adapter = DiscordAdapter(_make_settings(webhook_url="https://discord.com/api/webhooks/x/y"))
        caps = adapter.get_capabilities()
        assert caps.supports_mentions is False
        assert caps.supports_analytics is False


# ── GTM embed builder ─────────────────────────────────────────────────────────

class TestBuildGtmEmbed:
    def setup_method(self):
        self.adapter = DiscordAdapter(_make_settings())

    def test_single_line_content_becomes_title(self):
        embed = self.adapter._build_gtm_embed("Launch day!")
        assert embed["title"] == "Launch day!"
        assert "description" not in embed

    def test_multiline_splits_title_and_body(self):
        embed = self.adapter._build_gtm_embed("Q2 GTM Update\nRevenue up 20% this week.")
        assert embed["title"] == "Q2 GTM Update"
        assert "Revenue up 20%" in embed["description"]

    def test_revenue_keyword_triggers_gtm_color(self):
        embed = self.adapter._build_gtm_embed("Revenue milestone hit — earned $500 USDC")
        assert embed["color"] == _COLOR_GTM

    def test_warning_keyword_triggers_warn_color(self):
        embed = self.adapter._build_gtm_embed("Alert: posting failed due to rate limit error")
        assert embed["color"] == _COLOR_WARN

    def test_neutral_content_uses_default_color(self):
        embed = self.adapter._build_gtm_embed("Weekly check-in from Talos agent")
        assert embed["color"] == _COLOR_DEFAULT

    def test_metric_pairs_become_inline_fields(self):
        content = "Stats\nFollowers: 1200\nEngagement: 4.5%"
        embed = self.adapter._build_gtm_embed(content)
        assert "fields" in embed
        names = [f["name"] for f in embed["fields"]]
        assert "Followers" in names

    def test_footer_and_timestamp_always_present(self):
        embed = self.adapter._build_gtm_embed("Hello")
        assert embed["footer"]["text"] == "Talos Agent · GTM Cycle"
        assert "timestamp" in embed

    def test_title_truncated_at_256(self):
        long = "A" * 300
        embed = self.adapter._build_gtm_embed(long)
        assert len(embed["title"]) == 256


# ── post() via webhook ────────────────────────────────────────────────────────

class TestPostWebhook:
    @pytest.mark.asyncio
    @respx.mock
    async def test_webhook_post_success(self):
        adapter = DiscordAdapter(_make_settings(webhook_url="https://discord.com/api/webhooks/1/tok"))
        respx.post("https://discord.com/api/webhooks/1/tok").mock(
            return_value=Response(
                200,
                json={"id": "999", "channel_id": "chan1", "guild_id": "guild1"},
            )
        )
        result = await adapter.post("GTM launch — revenue: 200 USDC")
        assert result.status == "posted"
        assert result.post_id == "999"
        assert "guild1/chan1/999" in result.url

    @pytest.mark.asyncio
    @respx.mock
    async def test_webhook_post_http_error(self):
        adapter = DiscordAdapter(_make_settings(webhook_url="https://discord.com/api/webhooks/1/bad"))
        respx.post("https://discord.com/api/webhooks/1/bad").mock(
            return_value=Response(401, json={"message": "401: Unauthorized"})
        )
        result = await adapter.post("Test content")
        assert result.status == "failed"
        assert "401" in result.error

    @pytest.mark.asyncio
    async def test_post_returns_failed_when_not_configured(self):
        adapter = DiscordAdapter(_make_settings())
        result = await adapter.post("Hello")
        assert result.status == "failed"
        assert "not configured" in result.error

    @pytest.mark.asyncio
    async def test_post_validates_char_limit(self):
        adapter = DiscordAdapter(_make_settings(webhook_url="https://discord.com/api/webhooks/1/tok"))
        result = await adapter.post("x" * 2001)
        assert result.status == "failed"
        assert "2000" in result.error


# ── post() via bot API ────────────────────────────────────────────────────────

class TestPostBotApi:
    @pytest.mark.asyncio
    @respx.mock
    async def test_bot_api_post_success(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        respx.post(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(
                200,
                json={"id": "777", "guild_id": "gld"},
            )
        )
        result = await adapter.post("Weekly GTM update")
        assert result.status == "posted"
        assert result.post_id == "777"
        assert result.metadata["method"] == "bot_api"

    @pytest.mark.asyncio
    @respx.mock
    async def test_bot_api_post_failure(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        respx.post(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(403, json={"message": "Missing Permissions"})
        )
        result = await adapter.post("Test")
        assert result.status == "failed"
        assert "403" in result.error


# ── reply() ───────────────────────────────────────────────────────────────────

class TestReply:
    @pytest.mark.asyncio
    @respx.mock
    async def test_reply_parses_url_and_posts(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        target = "https://discord.com/channels/555/42/888"
        respx.post(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(200, json={"id": "999"})
        )
        result = await adapter.reply(target, "Great point!")
        assert result.status == "posted"
        assert result.metadata["reply_to"] == "888"

    @pytest.mark.asyncio
    async def test_reply_fails_without_credentials(self):
        adapter = DiscordAdapter(_make_settings(webhook_url="https://discord.com/api/webhooks/1/tok"))
        result = await adapter.reply("https://discord.com/channels/1/2/3", "reply")
        assert result.status == "failed"
        assert "BOT_TOKEN" in result.error


# ── get_mentions() ────────────────────────────────────────────────────────────

class TestGetMentions:
    @pytest.mark.asyncio
    @respx.mock
    async def test_filters_messages_containing_bot_mention(self):
        adapter = DiscordAdapter(
            _make_settings(bot_token="tok", channel_id="42", guild_id="gld")
        )
        adapter._cached_bot_id = "BOT123"

        respx.get(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(
                200,
                json=[
                    {"id": "1", "author": {"username": "alice"}, "content": "hi <@BOT123>!", "timestamp": "t1"},
                    {"id": "2", "author": {"username": "bob"}, "content": "no mention here", "timestamp": "t2"},
                ],
            )
        )
        mentions = await adapter.get_mentions()
        assert len(mentions) == 1
        assert mentions[0]["author"] == "alice"

    @pytest.mark.asyncio
    async def test_returns_empty_without_credentials(self):
        adapter = DiscordAdapter(_make_settings())
        result = await adapter.get_mentions()
        assert result == []


# ── search() ─────────────────────────────────────────────────────────────────

class TestSearch:
    @pytest.mark.asyncio
    @respx.mock
    async def test_client_side_keyword_filter(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        respx.get(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(
                200,
                json=[
                    {"id": "1", "author": {"username": "u1"}, "content": "Stellar blockchain launch", "timestamp": "t1"},
                    {"id": "2", "author": {"username": "u2"}, "content": "random chat", "timestamp": "t2"},
                ],
            )
        )
        results = await adapter.search("stellar")
        assert len(results) == 1
        assert "Stellar" in results[0]["content"]

    @pytest.mark.asyncio
    async def test_returns_empty_without_credentials(self):
        adapter = DiscordAdapter(_make_settings())
        result = await adapter.search("test")
        assert result == []


# ── get_post_performance() ────────────────────────────────────────────────────

class TestGetPostPerformance:
    @pytest.mark.asyncio
    @respx.mock
    async def test_returns_reaction_counts_on_match(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        respx.get(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(
                200,
                json=[
                    {
                        "id": "1",
                        "content": "GTM launch milestone hit",
                        "timestamp": "t1",
                        "reactions": [
                            {"emoji": {"name": "🚀"}, "count": 5},
                            {"emoji": {"name": "❤️"}, "count": 3},
                        ],
                    }
                ],
            )
        )
        perf = await adapter.get_post_performance("milestone hit")
        assert perf["found"] is True
        assert perf["total_reactions"] == 8
        assert perf["reactions"]["🚀"] == 5

    @pytest.mark.asyncio
    @respx.mock
    async def test_returns_not_found_on_miss(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", channel_id="42"))
        respx.get(f"{_DISCORD_API}/channels/42/messages").mock(
            return_value=Response(200, json=[{"id": "1", "content": "unrelated", "timestamp": "t", "reactions": []}])
        )
        perf = await adapter.get_post_performance("xyzzy")
        assert perf["found"] is False


# ── get_profile_stats() ───────────────────────────────────────────────────────

class TestGetProfileStats:
    @pytest.mark.asyncio
    @respx.mock
    async def test_returns_bot_and_guild_stats(self):
        adapter = DiscordAdapter(_make_settings(bot_token="tok", guild_id="gld"))
        respx.get(f"{_DISCORD_API}/users/@me").mock(
            return_value=Response(200, json={"id": "BOT123", "username": "TalosBot"})
        )
        respx.get(f"{_DISCORD_API}/guilds/gld").mock(
            return_value=Response(
                200,
                json={"name": "Talos Community", "approximate_member_count": 800, "approximate_presence_count": 50},
            )
        )
        stats = await adapter.get_profile_stats()
        assert stats["bot_username"] == "TalosBot"
        assert stats["member_count"] == 800

    @pytest.mark.asyncio
    async def test_returns_error_without_bot_token(self):
        adapter = DiscordAdapter(_make_settings())
        stats = await adapter.get_profile_stats()
        assert "error" in stats


# ── Reconnect Policy ───────────────────────────────────────────────────────────

class TestReconnectPolicy:
    @pytest.mark.asyncio
    @respx.mock
    async def test_webhook_reconnect_succeeds_on_second_attempt(self):
        config = DiscordAdapterConfig(
            channel_id="",
            guild_id="",
            legacy_webhook_url="https://discord.com/api/webhooks/1/tok",
            legacy_bot_token="",
            reconnect_enabled=True,
            reconnect_max_attempts=3,
            reconnect_backoff_initial=0.1,
            reconnect_backoff_max=1.0,
        )
        adapter = DiscordAdapter(config)
        
        call_count = 0
        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return Response(503, json={"message": "Service Unavailable"})
            return Response(200, json={"id": "999", "channel_id": "chan1", "guild_id": "guild1"})
        
        respx.post("https://discord.com/api/webhooks/1/tok").mock(side_effect=side_effect)
        result = await adapter.post("Test content")
        
        assert result.status == "posted"
        assert result.post_id == "999"
        assert result.metadata["reconnect_attempts"] == 1
        assert call_count == 2

    @pytest.mark.asyncio
    @respx.mock
    async def test_webhook_reconnect_fails_after_max_attempts(self):
        config = DiscordAdapterConfig(
            channel_id="",
            guild_id="",
            legacy_webhook_url="https://discord.com/api/webhooks/1/tok",
            legacy_bot_token="",
            reconnect_enabled=True,
            reconnect_max_attempts=2,
            reconnect_backoff_initial=0.1,
            reconnect_backoff_max=1.0,
        )
        adapter = DiscordAdapter(config)
        
        respx.post("https://discord.com/api/webhooks/1/tok").mock(
            return_value=Response(503, json={"message": "Service Unavailable"})
        )
        result = await adapter.post("Test content")
        
        assert result.status == "failed"
        assert "after 3 attempts" in result.error
        assert adapter._consecutive_failures == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_webhook_reconnect_disabled_backward_compatible(self):
        config = DiscordAdapterConfig(
            channel_id="",
            guild_id="",
            legacy_webhook_url="https://discord.com/api/webhooks/1/tok",
            legacy_bot_token="",
            reconnect_enabled=False,
        )
        adapter = DiscordAdapter(config)
        
        respx.post("https://discord.com/api/webhooks/1/tok").mock(
            return_value=Response(503, json={"message": "Service Unavailable"})
        )
        result = await adapter.post("Test content")
        
        assert result.status == "failed"
        assert "after 3 attempts" not in result.error
        assert "503" in result.error

    @pytest.mark.asyncio
    @respx.mock
    async def test_api_reconnect_succeeds_on_second_attempt(self):
        config = DiscordAdapterConfig(
            channel_id="42",
            guild_id="gld",
            legacy_webhook_url="",
            legacy_bot_token="tok",
            reconnect_enabled=True,
            reconnect_max_attempts=3,
            reconnect_backoff_initial=0.1,
            reconnect_backoff_max=1.0,
        )
        adapter = DiscordAdapter(config)
        
        call_count = 0
        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return Response(502, json={"message": "Bad Gateway"})
            return Response(200, json={"id": "777", "guild_id": "gld"})
        
        respx.post(f"{_DISCORD_API}/channels/42/messages").mock(side_effect=side_effect)
        result = await adapter.post("Test content")
        
        assert result.status == "posted"
        assert result.post_id == "777"
        assert result.metadata["reconnect_attempts"] == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_reconnect_resets_on_success(self):
        config = DiscordAdapterConfig(
            channel_id="",
            guild_id="",
            legacy_webhook_url="https://discord.com/api/webhooks/1/tok",
            legacy_bot_token="",
            reconnect_enabled=True,
            reconnect_max_attempts=2,
            reconnect_backoff_initial=0.1,
            reconnect_backoff_max=1.0,
        )
        adapter = DiscordAdapter(config)
        
        respx.post("https://discord.com/api/webhooks/1/tok").mock(
            return_value=Response(200, json={"id": "999", "channel_id": "chan1", "guild_id": "guild1"})
        )
        
        await adapter.post("Success")
        assert adapter._consecutive_failures == 0
        
        respx.post("https://discord.com/api/webhooks/1/tok").mock(
            return_value=Response(503, json={"message": "Service Unavailable"})
        )
        result = await adapter.post("Failure")
        assert result.status == "failed"
        assert adapter._consecutive_failures == 1

    def test_config_validation_rejects_negative_max_attempts(self):
        with pytest.raises(ValueError, match="reconnect_max_attempts must be non-negative"):
            DiscordAdapterConfig(
                channel_id="",
                guild_id="",
                legacy_webhook_url="",
                legacy_bot_token="",
                reconnect_max_attempts=-1,
            )

    def test_config_validation_rejects_invalid_backoff(self):
        with pytest.raises(ValueError, match="reconnect_backoff_initial and reconnect_backoff_max must be positive"):
            DiscordAdapterConfig(
                channel_id="",
                guild_id="",
                legacy_webhook_url="",
                legacy_bot_token="",
                reconnect_backoff_initial=0,
            )

    def test_config_validation_rejects_backoff_initial_exceeding_max(self):
        with pytest.raises(ValueError, match="reconnect_backoff_initial must not exceed reconnect_backoff_max"):
            DiscordAdapterConfig(
                channel_id="",
                guild_id="",
                legacy_webhook_url="",
                legacy_bot_token="",
                reconnect_backoff_initial=10.0,
                reconnect_backoff_max=5.0,
            )

    def test_config_default_values(self):
        config = DiscordAdapterConfig()
        assert config.reconnect_enabled is False
        assert config.reconnect_max_attempts == 3
        assert config.reconnect_backoff_initial == 1.0
        assert config.reconnect_backoff_max == 30.0

    def test_health_snapshot_includes_reconnect_state(self):
        config = DiscordAdapterConfig(
            channel_id="42",
            guild_id="gld",
            legacy_webhook_url="https://discord.com/api/webhooks/1/tok",
            legacy_bot_token="tok",
            reconnect_enabled=True,
        )
        adapter = DiscordAdapter(config)
        snapshot = adapter.health_snapshot()
        
        assert snapshot.reconnect_enabled is True
        assert snapshot.consecutive_failures == 0
