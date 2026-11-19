"""Tests for adapter health probes.

Coverage
--------
DiscordProbe:        healthy (webhook), healthy (bot), degraded (partial creds), disabled
TelegramProbe:       healthy, degraded (token only), degraded (chat only), disabled
XProbe:              healthy, degraded (creds but no browser), disabled
BrowserSessionProbe: healthy, degraded (no page), disabled (no stagehand), disabled (None)
StellarPaymentProbe: healthy, degraded (uninitialized), disabled (no api), disabled (None)
X402PaymentProbe:    healthy, disabled (no wallet), degraded (uninitialized), disabled (no api)
AdapterHealthReporter: combined snapshot across social/browser/payment, timeout path, exception resilience
ProbeResult / HealthReport: to_dict(), error_category, checked_at present, state ordering
Sanitization:        redaction of Stellar secret seeds, Discord tokens, API keys, Bearer tokens
CLI diagnostics:     formatted output and json output
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from click.testing import CliRunner
from talos_agent.adapters.health import (
    AdapterHealthReporter,
    AdapterState,
    BrowserSessionProbe,
    DiscordProbe,
    ErrorCategory,
    HealthReport,
    ProbeResult,
    StellarPaymentProbe,
    TelegramProbe,
    X402PaymentProbe,
    XProbe,
    _browser_is_live,
    _sanitize_health_detail,
    _worst,
)
from talos_agent.adapters.registry import AdapterRegistry
from talos_agent.cli import main

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


def _stellar_kit(has_api=True, initialized=True):
    kit = MagicMock()
    kit._api = MagicMock() if has_api else None
    kit._initialized = initialized
    kit.health_snapshot = lambda: {"has_api": has_api, "initialized": initialized}
    return kit


def _x402_signer(has_api=True, initialized=True, has_wallet=True, wallet_address="GD5J..."):
    signer = MagicMock()
    signer._api = MagicMock() if has_api else None
    signer._initialized = initialized
    signer._wallet_address = wallet_address if has_wallet else None
    signer.health_snapshot = lambda: {
        "has_api": has_api,
        "initialized": initialized,
        "has_wallet": has_wallet,
    }
    return signer


# ─── DiscordProbe ─────────────────────────────────────────────────────────────


class TestDiscordProbe:
    @pytest.mark.asyncio
    async def test_healthy_via_webhook(self):
        result = await DiscordProbe(_discord(webhook="https://discord.com/api/webhooks/x/y")).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert "webhook" in result.detail

    @pytest.mark.asyncio
    async def test_healthy_via_bot_token_and_channel(self):
        result = await DiscordProbe(_discord(bot_token="tok", channel_id="123")).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert "bot token" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_token_without_channel(self):
        result = await DiscordProbe(_discord(bot_token="tok")).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.MISSING_CREDENTIALS
        assert "DISCORD_CHANNEL_ID" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_channel_without_token(self):
        result = await DiscordProbe(_discord(channel_id="123")).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.MISSING_CREDENTIALS
        assert "DISCORD_BOT_TOKEN" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await DiscordProbe(_discord()).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "Discord"

    @pytest.mark.asyncio
    async def test_webhook_takes_priority_over_bot(self):
        # Both present — webhook path is preferred
        result = await DiscordProbe(
            _discord(webhook="https://discord.com/api/webhooks/x/y", bot_token="tok", channel_id="123")
        ).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert "webhook" in result.detail


# ─── TelegramProbe ────────────────────────────────────────────────────────────


class TestTelegramProbe:
    @pytest.mark.asyncio
    async def test_healthy_both_credentials(self):
        result = await TelegramProbe(_telegram(bot_token="abc", chat_id="@chan")).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "Telegram"

    @pytest.mark.asyncio
    async def test_degraded_token_only(self):
        result = await TelegramProbe(_telegram(bot_token="abc")).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.MISSING_CREDENTIALS
        assert "telegram_chat_id" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_chat_only(self):
        result = await TelegramProbe(_telegram(chat_id="@chan")).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.MISSING_CREDENTIALS
        assert "telegram_bot_token" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await TelegramProbe(_telegram()).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE

    @pytest.mark.asyncio
    async def test_healthy_detail_mentions_both(self):
        result = await TelegramProbe(_telegram(bot_token="t", chat_id="c")).probe()
        assert result.error_category == ErrorCategory.NONE
        assert "bot token" in result.detail and "chat ID" in result.detail


# ─── XProbe ───────────────────────────────────────────────────────────────────


class TestXProbe:
    @pytest.mark.asyncio
    async def test_healthy_creds_and_live_browser(self):
        result = await XProbe(
            _x_adapter(username="user", password="pass", browser=_live_browser())
        ).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "X"

    @pytest.mark.asyncio
    async def test_degraded_creds_but_no_browser(self):
        result = await XProbe(_x_adapter(username="user", password="pass")).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.DEPENDENCY_UNAVAILABLE
        assert "browser session is not initialised" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_creds_browser_no_page(self):
        result = await XProbe(
            _x_adapter(username="user", password="pass", browser=_stagehand_no_page())
        ).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.DEPENDENCY_UNAVAILABLE

    @pytest.mark.asyncio
    async def test_disabled_no_credentials(self):
        result = await XProbe(_x_adapter()).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE
        assert "X_USERNAME" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_username_only(self):
        # Only username — no password → disabled (not enough for login)
        result = await XProbe(_x_adapter(username="user")).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE


# ─── BrowserSessionProbe ─────────────────────────────────────────────────────


class TestBrowserSessionProbe:
    @pytest.mark.asyncio
    async def test_healthy_stagehand_with_page(self):
        result = await BrowserSessionProbe(_live_browser()).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "BrowserSession"

    @pytest.mark.asyncio
    async def test_degraded_stagehand_no_page(self):
        result = await BrowserSessionProbe(_stagehand_no_page()).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.DEPENDENCY_UNAVAILABLE
        assert "no page" in result.detail.lower()

    @pytest.mark.asyncio
    async def test_disabled_browser_no_stagehand(self):
        result = await BrowserSessionProbe(_browser_no_stagehand()).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE

    @pytest.mark.asyncio
    async def test_disabled_none_browser(self):
        result = await BrowserSessionProbe(None).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE


# ─── StellarPaymentProbe ─────────────────────────────────────────────────────


class TestStellarPaymentProbe:
    @pytest.mark.asyncio
    async def test_healthy_initialized_with_api(self):
        result = await StellarPaymentProbe(_stellar_kit(has_api=True, initialized=True)).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "StellarPayment"
        assert "initialized" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_uninitialized(self):
        result = await StellarPaymentProbe(_stellar_kit(has_api=True, initialized=False)).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.DEPENDENCY_UNAVAILABLE
        assert "not initialized" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_api_client(self):
        result = await StellarPaymentProbe(_stellar_kit(has_api=False)).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE
        assert "disabled" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_none_instance(self):
        result = await StellarPaymentProbe(None).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE


# ─── X402PaymentProbe ────────────────────────────────────────────────────────


class TestX402PaymentProbe:
    @pytest.mark.asyncio
    async def test_healthy_initialized_with_wallet(self):
        result = await X402PaymentProbe(_x402_signer(has_api=True, initialized=True, has_wallet=True)).probe()
        assert result.state == AdapterState.HEALTHY
        assert result.error_category == ErrorCategory.NONE
        assert result.adapter == "X402Signer"
        # Secret check: ensure no private key or raw address is exposed in detail
        assert "GD5J" not in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_wallet(self):
        result = await X402PaymentProbe(_x402_signer(has_api=True, initialized=True, has_wallet=False)).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE
        assert "no agent wallet" in result.detail

    @pytest.mark.asyncio
    async def test_degraded_uninitialized(self):
        result = await X402PaymentProbe(_x402_signer(has_api=True, initialized=False)).probe()
        assert result.state == AdapterState.DEGRADED
        assert result.error_category == ErrorCategory.DEPENDENCY_UNAVAILABLE
        assert "not initialized" in result.detail

    @pytest.mark.asyncio
    async def test_disabled_no_api_client(self):
        result = await X402PaymentProbe(_x402_signer(has_api=False)).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE

    @pytest.mark.asyncio
    async def test_disabled_none_instance(self):
        result = await X402PaymentProbe(None).probe()
        assert result.state == AdapterState.DISABLED
        assert result.error_category == ErrorCategory.NONE


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


# ─── Sanitization ────────────────────────────────────────────────────────────


class TestSanitization:
    def test_redacts_stellar_secret_seed(self):
        secret = "S" + "B" * 55
        raw = f"Error with secret key {secret} in stellar connection"
        sanitized = _sanitize_health_detail(raw)
        assert secret not in sanitized
        assert "[REDACTED]" in sanitized

    def test_redacts_bearer_token(self):
        token_body = "eyJhbGci" + "OiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        raw = f"Authorization failed with Bearer {token_body}"
        sanitized = _sanitize_health_detail(raw)
        assert token_body not in sanitized
        assert "[REDACTED]" in sanitized

    def test_redacts_discord_token(self):
        token = "A" * 24 + "." + "B" * 6 + "." + "C" * 27
        raw = f"Discord auth failed for token {token}"
        sanitized = _sanitize_health_detail(raw)
        assert token not in sanitized

    def test_redacts_openai_key(self):
        key = "sk-" + "a" * 32
        raw = f"API key {key} invalid"
        sanitized = _sanitize_health_detail(raw)
        assert key not in sanitized
        assert "[REDACTED]" in sanitized

    def test_empty_string_safe(self):
        assert _sanitize_health_detail("") == ""


# ─── ProbeResult / HealthReport ───────────────────────────────────────────────


class TestProbeResult:
    def test_to_dict_keys(self):
        r = ProbeResult(
            adapter="Discord",
            state=AdapterState.HEALTHY,
            detail="ok",
            error_category=ErrorCategory.NONE,
        )
        d = r.to_dict()
        assert set(d.keys()) == {"adapter", "state", "detail", "error_category", "checked_at"}
        assert d["state"] == "healthy"
        assert d["error_category"] == "none"

    def test_checked_at_is_utc(self):
        r = ProbeResult(adapter="X", state=AdapterState.DISABLED)
        assert r.checked_at.tzinfo is not None

    def test_default_detail_empty(self):
        r = ProbeResult(adapter="Telegram", state=AdapterState.DEGRADED)
        assert r.detail == ""
        assert r.error_category == ErrorCategory.NONE


class TestHealthReport:
    def _sample_report(self):
        return HealthReport(
            overall=AdapterState.DEGRADED,
            adapters=[
                ProbeResult(
                    adapter="Discord",
                    state=AdapterState.HEALTHY,
                    detail="ok",
                    error_category=ErrorCategory.NONE,
                ),
                ProbeResult(
                    adapter="Telegram",
                    state=AdapterState.DEGRADED,
                    detail="partial",
                    error_category=ErrorCategory.MISSING_CREDENTIALS,
                ),
            ],
        )

    def test_to_dict_structure(self):
        d = self._sample_report().to_dict()
        assert d["overall"] == "degraded"
        assert len(d["adapters"]) == 2
        assert "checked_at" in d
        assert d["adapters"][1]["error_category"] == "missing_credentials"

    def test_adapter_names_in_report(self):
        d = self._sample_report().to_dict()
        names = [a["adapter"] for a in d["adapters"]]
        assert "Discord" in names
        assert "Telegram" in names

    def test_has_degraded_and_degraded_adapters(self):
        report = self._sample_report()
        assert report.has_degraded is True
        assert len(report.degraded_adapters) == 1
        assert report.degraded_adapters[0].adapter == "Telegram"


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
        assert report.adapters[0].error_category == ErrorCategory.NONE

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
    async def test_payment_adapters_included(self):
        stellar = _stellar_kit(has_api=True, initialized=True)
        signer = _x402_signer(has_api=True, initialized=True, has_wallet=True)
        reporter = AdapterHealthReporter(stellar_kit=stellar, x402_signer=signer)
        report = await reporter.report()
        assert report.overall == AdapterState.HEALTHY
        names = [a.adapter for a in report.adapters]
        assert "StellarPayment" in names
        assert "X402Signer" in names

    @pytest.mark.asyncio
    async def test_exception_in_one_probe_does_not_crash_report(self):
        """When an adapter probe raises an unhandled exception, it is caught as DEGRADED."""
        class CrashingAdapter:
            channel_name = "Crashing"
            def probe(self):
                raise RuntimeError("database disk malfunction")

        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        registry = _make_registry(discord, CrashingAdapter())
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.DEGRADED
        adapters_by_name = {a.adapter: a for a in report.adapters}
        assert adapters_by_name["Discord"].state == AdapterState.HEALTHY
        assert adapters_by_name["Crashing"].state == AdapterState.DEGRADED
        assert adapters_by_name["Crashing"].error_category == ErrorCategory.INTERNAL_ERROR
        assert "RuntimeError" in adapters_by_name["Crashing"].detail

    @pytest.mark.asyncio
    async def test_timeout_probe_returns_timeout_state(self):
        """A probe that hangs beyond the timeout is reported as TIMEOUT."""

        class HangingProbeAdapter:
            channel_name = "Hanging"

            async def probe(self) -> ProbeResult:
                await asyncio.sleep(99)
                return ProbeResult(adapter="Hanging", state=AdapterState.HEALTHY)

        registry = AdapterRegistry()
        registry.register(HangingProbeAdapter())
        reporter = AdapterHealthReporter(registry, timeout=0.05)
        report = await reporter.report()

        assert report.overall == AdapterState.TIMEOUT
        assert report.adapters[0].state == AdapterState.TIMEOUT
        assert report.adapters[0].error_category == ErrorCategory.TIMEOUT

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
        assert d["adapters"][0]["error_category"] == "none"

    @pytest.mark.asyncio
    async def test_multiple_adapters_all_healthy(self):
        discord = _discord(webhook="https://discord.com/api/webhooks/x/y")
        telegram = _telegram(bot_token="tok", chat_id="@chan")
        registry = _make_registry(discord, telegram)
        reporter = AdapterHealthReporter(registry)
        report = await reporter.report()
        assert report.overall == AdapterState.HEALTHY
        assert len(report.adapters) == 2


# ─── CLI Diagnostics Command Tests ───────────────────────────────────────────


class TestDiagnosticsCLI:
    def test_diagnostics_command_runs(self, monkeypatch):
        runner = CliRunner()
        result = runner.invoke(main, ["diagnostics"])
        assert result.exit_code == 0
        assert "Adapter Health & Diagnostics" in result.output

    def test_diagnostics_json_output(self, monkeypatch):
        runner = CliRunner()
        result = runner.invoke(main, ["diagnostics", "--json"])
        assert result.exit_code == 0
        assert '"overall":' in result.output
        assert '"adapters":' in result.output
        assert '"error_category":' in result.output
