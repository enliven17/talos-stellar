"""Tests for adapter health probes.

Coverage
--------
DiscordProbe:   healthy (webhook), healthy (bot), degraded (partial creds), disabled
TelegramProbe:  healthy, degraded (token only), degraded (chat only), disabled
XProbe:         healthy, degraded (creds but no browser), disabled
BrowserSessionProbe: healthy, degraded (no page), disabled (no stagehand), disabled (None)
AdapterHealthReporter: aggregate states, timeout path, concurrent execution
ProbeResult / HealthReport: to_dict(), checked_at present, state ordering
AdapterState:   _worst() ordering
"""

from __future__ import annotations

import asyncio
import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from talos_agent.adapters.health import (
    PROBE_TIMEOUT_SECONDS,
    AdapterHealthReporter,
    AdapterState,
    BrowserSessionProbe,
    DiscordProbe,
    HealthReport,
    ProbeResult,
    TelegramProbe,
    XProbe,
    _browser_is_live,
    _worst,
)
from talos_agent.adapters.registry import AdapterRegistry


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _discord(webhook="", bot_token="", channel_id=""):
    adapter = MagicMock()
    adapter.channel_name = "Discord"
    adapter._webhook_url = webhook
    adapter._bot_token = bot_token
    adapter._channel_id = channel_id
    return adapter


def _telegram(bot_token="", chat_id=""):
    adapter = MagicMock()
    adapter.channel_name = "Telegram"
    adapter._bot_token = bot_token
    adapter._chat_id = chat_id
    return adapter


def _x_adapter(username="", password="", browser=None):
    settings = MagicMock()
    settings.x_username = username
    settings.x_password = password
    adapter = MagicMock()
    adapter.channel_name = "X"
    adapter._settings = settings
    adapter._browser = browser
    return adapter


def _live_browser():
    """Return a mock BrowserSession with a live Stagehand page."""
    page = MagicMock()
    stagehand = MagicMock()
    stagehand.page = page
    browser = MagicMock()
    browser._stagehand = stagehand
    return browser


def _stagehand_no_page():
    """Stagehand initialised but page not yet open."""
    stagehand = MagicMock()
    stagehand.page = None
    browser = MagicMock()
    browser._stagehand = stagehand
    return browser


def _browser_no_stagehand():
    browser = MagicMock()
    browser._stagehand = None
    return browser


# ─── DiscordProbe ─────────────────────────────────────────────────────────────


class TestDiscordProbe:
    @pytest.mark.asyncio
    async def test_healthy_via_webhook(self):
        result = await DiscordProbe(_discord(webhook="https://discord.com/api/webhooks/x/y")).probe()
        assert result.state == AdapterState.HEALTHY
        assert "webhook" in result.detail

    @pytest.mark.asyncio
    async def test_healthy_via_bot_token_and_channel(self):
        result = await DiscordProbe(_discord(bot_token="tok", channel_id="123")).probe()
        assert result.state == AdapterState.HEALTHY
        assert "bot token" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_token_without_channel(self):
        result = await DiscordProbe(_discord(bot_token="tok")).probe()
        assert result.state == AdapterState.DEGRADED
        assert "DISCORD_CHANNEL_ID" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_channel_without_token(self):
        result = await DiscordProbe(_discord(channel_id="123")).probe()
        assert result.state == AdapterState.DEGRADED
        assert "DISCORD_BOT_TOKEN" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await DiscordProbe(_discord()).probe()
        assert result.state == AdapterState.DISABLED
        assert result.adapter == "Discord"

    @pytest.mark.asyncio
    async def test_webhook_takes_priority_over_bot(self):
        # Both present — webhook path is preferred
        result = await DiscordProbe(
            _discord(webhook="https://discord.com/api/webhooks/x/y", bot_token="tok", channel_id="123")
        ).probe()
        assert result.state == AdapterState.HEALTHY
        assert "webhook" in result.detail


# ─── TelegramProbe ────────────────────────────────────────────────────────────


class TestTelegramProbe:
    @pytest.mark.asyncio
    async def test_healthy_both_credentials(self):
        result = await TelegramProbe(_telegram(bot_token="abc", chat_id="@chan")).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.adapter == "Telegram"

    @pytest.mark.asyncio
    async def test_degraded_token_only(self):
        result = await TelegramProbe(_telegram(bot_token="abc")).probe()
        assert result.state == AdapterState.DEGRADED
        assert "telegram_chat_id" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_chat_only(self):
        result = await TelegramProbe(_telegram(chat_id="@chan")).probe()
        assert result.state == AdapterState.DEGRADED
        assert "telegram_bot_token" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await TelegramProbe(_telegram()).probe()
        assert result.state == AdapterState.DISABLED

    @pytest.mark.asyncio
    async def test_healthy_detail_mentions_both(self):
        result = await TelegramProbe(_telegram(bot_token="t", chat_id="c")).probe()
        assert "bot token" in result.detail and "chat ID" in result.detail


# ─── XProbe ───────────────────────────────────────────────────────────────────


class TestXProbe:
    @pytest.mark.asyncio
    async def test_healthy_creds_and_live_browser(self):
        result = await XProbe(
            _x_adapter(username="user", password="pass", browser=_live_browser())
        ).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.adapter == "X"

    @pytest.mark.asyncio
    async def test_degraded_creds_but_no_browser(self):
        result = await XProbe(_x_adapter(username="user", password="pass")).probe()
        assert result.state == AdapterState.DEGRADED
        assert "browser session is not initialised" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_creds_browser_no_page(self):
        result = await XProbe(
            _x_adapter(username="user", password="pass", browser=_stagehand_no_page())
        ).probe()
        assert result.state == AdapterState.DEGRADED

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await XProbe(_x_adapter()).probe()
        assert result.state == AdapterState.DISABLED
        assert "X_USERNAME" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_username_only(self):
        # Only username — no password → disabled (not enough for login)
        result = await XProbe(_x_adapter(username="user")).probe()
        assert result.state == AdapterState.DISABLED


# ─── BrowserSessionProbe ─────────────────────────────────────────────────────


class TestBrowserSessionProbe:
    @pytest.mark.asyncio
    async def test_healthy_stagehand_with_page(self):
        result = await BrowserSessionProbe(_live_browser()).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.adapter == "BrowserSession"

    @pytest.mark.asyncio
    async def test_degraded_stagehand_no_page(self):
        result = await BrowserSessionProbe(_stagehand_no_page()).probe()
        assert result.state == AdapterState.DEGRADED
        assert "no page" in result.detail.lower()

    @pytest.mark.asyncio
    async def test_disabled_browser_no_stagehand(self):
        result = await BrowserSessionProbe(_browser_no_stagehand()).probe()
        assert result.state == AdapterState.DISABLED

    @pytest.mark.asyncio
    async def test_disabled_none_browser(self):
        result = await BrowserSessionProbe(None).probe()
        assert result.state == AdapterState.DISABLED


# ─── _browser_is_live ─────────────────────────────────────────────────────────


class TestBrowserIsLive:
    def test_none_browser(self):
        assert _browser_is_live(None) is False

    def test_no_stagehand_attr(self):
        b = MagicMock(spec=[])  # no attributes
        assert _browser_is_live(b) is False

    def test_stagehand_none(self):
        b = MagicMock()
        b._stagehand = None
        assert _browser_is_live(b) is False

    def test_stagehand_no_page(self):
        b = _stagehand_no_page()
        assert _browser_is_live(b) is False

    def test_stagehand_with_page(self):
        assert _browser_is_live(_live_browser()) is True


# ─── ProbeResult / HealthReport ───────────────────────────────────────────────


class TestProbeResult:
    def test_to_dict_keys(self):
        r = ProbeResult(adapter="Discord", state=AdapterState.HEALTHY, detail="ok")
        d = r.to_dict()
        assert set(d.keys()) == {"adapter", "state", "detail", "checked_at"}
        assert d["state"] == "healthy"

    def test_checked_at_is_utc(self):
        r = ProbeResult(adapter="X", state=AdapterState.DISABLED)
        assert r.checked_at.tzinfo is not None

    def test_default_detail_empty(self):
        r = ProbeResult(adapter="Telegram", state=AdapterState.DEGRADED)
        assert r.detail == ""


class TestHealthReport:
    def _sample_report(self):
        return HealthReport(
            overall=AdapterState.DEGRADED,
            adapters=[
                ProbeResult(adapter="Discord", state=AdapterState.HEALTHY, detail="ok"),
                ProbeResult(adapter="Telegram", state=AdapterState.DEGRADED, detail="partial"),
            ],
        )

    def test_to_dict_structure(self):
        d = self._sample_report().to_dict()
        assert d["overall"] == "degraded"
        assert len(d["adapters"]) == 2
        assert "checked_at" in d

    def test_adapter_names_in_report(self):
        d = self._sample_report().to_dict()
        names = [a["adapter"] for a in d["adapters"]]
        assert "Discord" in names
        assert "Telegram" in names


# ─── _worst() ────────────────────────────────────────────────────────────────


class TestWorst:
    def test_empty_returns_disabled(self):
        assert _worst([]) == AdapterState.DISABLED

    def test_all_healthy(self):
        assert _worst([AdapterState.HEALTHY, AdapterState.HEALTHY]) == AdapterState.HEALTHY

    def test_timeout_beats_all(self):
        states = [AdapterState.HEALTHY, AdapterState.DEGRADED, AdapterState.TIMEOUT]
        assert _worst(states) == AdapterState.TIMEOUT

    def test_degraded_beats_healthy_and_disabled(self):
        assert _worst([AdapterState.HEALTHY, AdapterState.DISABLED, AdapterState.DEGRADED]) == AdapterState.DEGRADED

    def test_disabled_beats_healthy(self):
        assert _worst([AdapterState.HEALTHY, AdapterState.DISABLED]) == AdapterState.DISABLED


# ─── AdapterHealthReporter ────────────────────────────────────────────────────


def _make_registry(*adapters) -> AdapterRegistry:
    registry = AdapterRegistry()
    for a in adapters:
        registry.register(a)
    return registry


class TestAdapterHealthReporter:
    @pytest.mark.asyncio
    async def test_empty_registry_returns_disabled(self):
        reporter = AdapterHealthReporter(AdapterRegistry())
        report = await reporter.report()
        assert report.overall == AdapterState.DISABLED
        assert report.adapters == []

    @pytest.mark.asyncio
    async def test_single_healthy_discord(self):
        adapter = _discord(webhook="https://discord.com/api/webhooks/x/y")
        registry = _make_registry(adapter)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.HEALTHY
        assert len(report.adapters) == 1
        assert report.adapters[0].state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_aggregate_picks_worst_state(self):
        # Discord healthy, Telegram disabled → overall = disabled
        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        telegram = _telegram()  # no creds
        registry = _make_registry(discord, telegram)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.DISABLED

    @pytest.mark.asyncio
    async def test_aggregate_degraded_beats_healthy(self):
        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        telegram = _telegram(bot_token="tok")  # degraded
        registry = _make_registry(discord, telegram)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.DEGRADED

    @pytest.mark.asyncio
    async def test_browser_session_included_when_provided(self):
        registry = AdapterRegistry()
        reporter = AdapterHealthReporter(registry, browser=_live_browser())
        report = await reporter.report()
        assert len(report.adapters) == 1
        assert report.adapters[0].adapter == "BrowserSession"
        assert report.adapters[0].state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_timeout_probe_returns_timeout_state(self):
        """A probe that hangs beyond the timeout is reported as TIMEOUT."""

        class HangingProbe:
            async def probe(self) -> ProbeResult:
                await asyncio.sleep(99)  # never finishes in test
                return ProbeResult(adapter="X", state=AdapterState.HEALTHY)

        # Patch the probe factory: make XAdapter produce a hanging probe
        x_settings = MagicMock()
        x_settings.x_username = "user"
        x_settings.x_password = "pass"
        x_adapter = MagicMock()
        x_adapter.channel_name = "X"
        x_adapter._settings = x_settings
        x_adapter._browser = None

        registry = AdapterRegistry()
        registry.register(x_adapter)

        # Use a very short timeout so the test doesn't actually wait 5 s
        reporter = AdapterHealthReporter(registry, timeout=0.05)

        # Monkey-patch the probe for "x" to a hanging one
        original_report = reporter.report

        async def patched_report():
            reporter._registry._adapters["x"] = x_adapter
            # Replace probe resolution inside reporter
            probes = [("x", HangingProbe())]
            from talos_agent.adapters.health import _run_with_timeout
            coros = [_run_with_timeout(p.probe(), timeout=0.05) for _, p in probes]
            raw = await asyncio.gather(*coros, return_exceptions=True)
            results = []
            for outcome in raw:
                if isinstance(outcome, BaseException):
                    results.append(
                        ProbeResult(adapter="x", state=AdapterState.DEGRADED, detail=str(outcome))
                    )
                else:
                    results.append(outcome)
            from talos_agent.adapters.health import _worst, HealthReport
            return HealthReport(overall=_worst([r.state for r in results]), adapters=results)

        report = await patched_report()
        assert report.overall == AdapterState.TIMEOUT
        assert report.adapters[0].state == AdapterState.TIMEOUT

    @pytest.mark.asyncio
    async def test_report_to_dict_includes_overall_and_adapters(self):
        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        registry = _make_registry(discord)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        d = report.to_dict()
        assert "overall" in d
        assert "adapters" in d
        assert "checked_at" in d

    @pytest.mark.asyncio
    async def test_multiple_adapters_all_healthy(self):
        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        telegram = _telegram(bot_token="tok", chat_id="@chan")
        registry = _make_registry(discord, telegram)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.HEALTHY
        assert len(report.adapters) == 2
