"""Tests for adapter capability negotiation report.

Coverage
--------
CapabilityReporter.report():
  Discord — available via webhook, available via bot+channel, unavailable
  Telegram — available, unavailable
  X — available, unavailable
  Generic adapter — fallback entry builder
  Empty registry — empty available and unavailable dicts
  Unavailable adapters kept out of .available
  Available adapters not in .unavailable

CapabilityEntry:
  supported_operations present for available adapters
  supported_operations empty for unavailable adapters
  required_config env_vars listed
  available_for_autonomous_use flag correct
  to_dict() structure

CapabilityReport:
  to_dict() structure — available, unavailable, generated_at
  generated_at is UTC

AdapterRegistry.capability_report():
  delegates to CapabilityReporter and returns CapabilityReport
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from talos_agent.adapters.diagnostics import (
    CapabilityEntry,
    CapabilityReport,
    CapabilityReporter,
    RequiredConfig,
    _discord_entry,
    _telegram_entry,
    _x_entry,
)
from talos_agent.adapters.registry import AdapterRegistry


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _discord(webhook="", bot_token="", channel_id=""):
    a = MagicMock()
    a.channel_name = "Discord"
    a._webhook_url = webhook
    a._bot_token = bot_token
    a._channel_id = channel_id
    return a


def _telegram(bot_token="", chat_id=""):
    a = MagicMock()
    a.channel_name = "Telegram"
    a._bot_token = bot_token
    a._chat_id = chat_id
    return a


def _x(username="", password=""):
    settings = MagicMock()
    settings.x_username = username
    settings.x_password = password
    a = MagicMock()
    a.channel_name = "X"
    a._settings = settings
    return a


def _registry(*adapters) -> AdapterRegistry:
    r = AdapterRegistry()
    for a in adapters:
        r.register(a)
    return r


# ─── Discord entry ────────────────────────────────────────────────────────────


class TestDiscordEntry:
    def test_available_via_webhook(self):
        entry = _discord_entry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        assert entry.available_for_autonomous_use is True
        assert "post" in entry.supported_operations

    def test_available_via_bot_and_channel(self):
        entry = _discord_entry(_discord(bot_token="tok", channel_id="123"))
        assert entry.available_for_autonomous_use is True
        assert "reply" in entry.supported_operations
        assert "search" in entry.supported_operations

    def test_unavailable_no_credentials(self):
        entry = _discord_entry(_discord())
        assert entry.available_for_autonomous_use is False
        assert entry.supported_operations == []

    def test_required_config_env_vars(self):
        entry = _discord_entry(_discord())
        assert "DISCORD_WEBHOOK_URL" in entry.required_config.env_vars

    def test_webhook_detail(self):
        entry = _discord_entry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        assert "webhook" in entry.detail.lower()

    def test_unavailable_detail_mentions_config(self):
        entry = _discord_entry(_discord())
        assert "DISCORD_WEBHOOK_URL" in entry.detail or "configure" in entry.detail.lower() or "Not configured" in entry.detail


# ─── Telegram entry ───────────────────────────────────────────────────────────


class TestTelegramEntry:
    def test_available_both_credentials(self):
        entry = _telegram_entry(_telegram(bot_token="tok", chat_id="@chan"))
        assert entry.available_for_autonomous_use is True
        assert "post" in entry.supported_operations
        assert "reply" in entry.supported_operations

    def test_unavailable_no_credentials(self):
        entry = _telegram_entry(_telegram())
        assert entry.available_for_autonomous_use is False
        assert entry.supported_operations == []

    def test_unavailable_token_only(self):
        entry = _telegram_entry(_telegram(bot_token="tok"))
        assert entry.available_for_autonomous_use is False

    def test_required_config_lists_both_vars(self):
        entry = _telegram_entry(_telegram())
        assert "TELEGRAM_BOT_TOKEN" in entry.required_config.env_vars
        assert "TELEGRAM_CHAT_ID" in entry.required_config.env_vars


# ─── X entry ─────────────────────────────────────────────────────────────────


class TestXEntry:
    def test_available_full_credentials(self):
        entry = _x_entry(_x(username="user", password="pass"))
        assert entry.available_for_autonomous_use is True
        assert "post" in entry.supported_operations
        assert "get_mentions" in entry.supported_operations

    def test_unavailable_no_credentials(self):
        entry = _x_entry(_x())
        assert entry.available_for_autonomous_use is False
        assert entry.supported_operations == []

    def test_required_config_lists_vars(self):
        entry = _x_entry(_x())
        assert "X_USERNAME" in entry.required_config.env_vars
        assert "X_PASSWORD" in entry.required_config.env_vars


# ─── CapabilityEntry.to_dict ──────────────────────────────────────────────────


class TestCapabilityEntryToDict:
    def test_to_dict_keys(self):
        entry = CapabilityEntry(
            adapter="Discord",
            supported_operations=["post"],
            required_config=RequiredConfig(env_vars=["DISCORD_WEBHOOK_URL"]),
            available_for_autonomous_use=True,
            detail="configured",
        )
        d = entry.to_dict()
        assert set(d.keys()) == {
            "adapter",
            "supported_operations",
            "required_config",
            "available_for_autonomous_use",
            "detail",
        }

    def test_required_config_in_dict(self):
        entry = CapabilityEntry(
            adapter="Discord",
            required_config=RequiredConfig(env_vars=["DISCORD_WEBHOOK_URL"]),
        )
        d = entry.to_dict()
        assert "env_vars" in d["required_config"]
        assert "DISCORD_WEBHOOK_URL" in d["required_config"]["env_vars"]


# ─── CapabilityReport.to_dict ────────────────────────────────────────────────


class TestCapabilityReportToDict:
    def test_to_dict_structure(self):
        report = CapabilityReport(
            available={"Discord": CapabilityEntry(adapter="Discord", available_for_autonomous_use=True)},
            unavailable={"Telegram": CapabilityEntry(adapter="Telegram", available_for_autonomous_use=False)},
        )
        d = report.to_dict()
        assert "available" in d
        assert "unavailable" in d
        assert "generated_at" in d

    def test_generated_at_is_utc(self):
        report = CapabilityReport()
        assert report.generated_at.tzinfo is not None


# ─── CapabilityReporter ───────────────────────────────────────────────────────


class TestCapabilityReporter:
    def test_empty_registry(self):
        reporter = CapabilityReporter(AdapterRegistry())
        report = reporter.report()
        assert isinstance(report, CapabilityReport)
        assert report.available == {}
        assert report.unavailable == {}

    def test_available_adapter_in_available_not_unavailable(self):
        reg = _registry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        report = CapabilityReporter(reg).report()
        assert "Discord" in report.available
        assert "Discord" not in report.unavailable

    def test_unavailable_adapter_in_unavailable_not_available(self):
        reg = _registry(_discord())  # no credentials
        report = CapabilityReporter(reg).report()
        assert "Discord" in report.unavailable
        assert "Discord" not in report.available

    def test_mixed_adapters_split_correctly(self):
        reg = _registry(
            _discord(webhook="https://discord.com/api/webhooks/x/y"),  # available
            _telegram(),  # unavailable
        )
        report = CapabilityReporter(reg).report()
        assert "Discord" in report.available
        assert "Telegram" in report.unavailable

    def test_all_available_when_configured(self):
        reg = _registry(
            _discord(webhook="https://discord.com/api/webhooks/x/y"),
            _telegram(bot_token="tok", chat_id="@chan"),
            _x(username="user", password="pass"),
        )
        report = CapabilityReporter(reg).report()
        assert len(report.available) == 3
        assert len(report.unavailable) == 0

    def test_all_unavailable_when_not_configured(self):
        reg = _registry(_discord(), _telegram(), _x())
        report = CapabilityReporter(reg).report()
        assert len(report.available) == 0
        assert len(report.unavailable) == 3

    def test_supported_operations_empty_for_unavailable(self):
        reg = _registry(_discord())
        report = CapabilityReporter(reg).report()
        assert report.unavailable["Discord"].supported_operations == []

    def test_supported_operations_non_empty_for_available(self):
        reg = _registry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        report = CapabilityReporter(reg).report()
        assert len(report.available["Discord"].supported_operations) > 0


# ─── AdapterRegistry.capability_report() ────────────────────────────────────


class TestRegistryCapabilityReport:
    def test_returns_capability_report(self):
        reg = _registry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        report = reg.capability_report()
        assert isinstance(report, CapabilityReport)

    def test_available_channels_match_available_in_report(self):
        reg = _registry(_discord(webhook="https://discord.com/api/webhooks/x/y"))
        report = reg.capability_report()
        assert "Discord" in report.available

    def test_unconfigured_adapter_not_in_available(self):
        reg = _registry(_telegram())
        report = reg.capability_report()
        assert "Telegram" not in report.available
        assert "Telegram" in report.unavailable
