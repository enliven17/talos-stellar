"""Tests for typed adapter health snapshots (talos_agent.adapters.snapshots).

Coverage
--------
Dataclasses:         to_dict() round-trips every field; frozen (immutable).
DiscordAdapter:      health_snapshot() returns a DiscordHealthSnapshot with correct fields
                      for no-creds / webhook-only / bot-token-only / fully-configured inputs.
TelegramAdapter:     health_snapshot() returns a TelegramHealthSnapshot, same input matrix.
XAdapter:            health_snapshot() returns an XHealthSnapshot (creds + browser liveness).
StellarKit:          health_snapshot() returns a StellarHealthSnapshot.
X402Signer:          health_snapshot() returns an X402HealthSnapshot.
SandboxedAdapter:    health_snapshot() forwards the wrapped adapter's typed snapshot unchanged.
Probe compatibility: DiscordProbe/TelegramProbe/XProbe/StellarPaymentProbe/X402PaymentProbe
                      all consume a real typed snapshot correctly (not just their MagicMock
                      fallback path, which test_adapter_health.py already covers).
Backward compat:     probes still accept a legacy dict[str, bool] snapshot unchanged.
Boundary/malformed:  health_snapshot() returning None, raising, or returning an unrecognised
                      type all fall back to private-attribute introspection instead of
                      crashing the probe (dependency-failure-shaped input).
"""

from __future__ import annotations

import asyncio
import dataclasses
from unittest.mock import MagicMock

import pytest

from talos_agent.adapters.capability import SandboxedAdapter
from talos_agent.adapters.discord import DiscordAdapter
from talos_agent.adapters.health import (
    _MISSING,
    AdapterState,
    DiscordProbe,
    StellarPaymentProbe,
    TelegramProbe,
    X402PaymentProbe,
    XProbe,
    _call_health_snapshot,
    _snapshot_bool,
    _snapshot_field,
)
from talos_agent.adapters.snapshots import (
    DiscordHealthSnapshot,
    StellarHealthSnapshot,
    TelegramHealthSnapshot,
    X402HealthSnapshot,
    XHealthSnapshot,
)
from talos_agent.adapters.telegram import TelegramAdapter
from talos_agent.adapters.x import XAdapter, XAdapterConfig
from talos_agent.config import Settings
from talos_agent.payments.stellar_kit import StellarKit
from talos_agent.payments.x402_signer import X402Signer


def _settings(**overrides) -> Settings:
    s = Settings()
    for key, value in overrides.items():
        setattr(s, key, value)
    return s


class _FakeSecrets:
    def __init__(self, **values: str) -> None:
        self._values = values

    def get(self, name: str) -> str:
        return self._values.get(name, "")


def _live_browser():
    page = MagicMock()
    stagehand = MagicMock()
    stagehand.page = page
    browser = MagicMock()
    browser._stagehand = stagehand
    return browser


# ─── Dataclass contracts ───────────────────────────────────────────────────────


class TestSnapshotDataclasses:
    def test_discord_to_dict_round_trips(self):
        snap = DiscordHealthSnapshot(has_webhook=True, has_token=False, has_channel=False)
        assert snap.to_dict() == {"has_webhook": True, "has_token": False, "has_channel": False, "reconnect_enabled": False, "consecutive_failures": 0}

    def test_telegram_to_dict_round_trips(self):
        snap = TelegramHealthSnapshot(has_token=True, has_chat=True)
        assert snap.to_dict() == {"has_token": True, "has_chat": True}

    def test_x_to_dict_round_trips(self):
        snap = XHealthSnapshot(has_username=True, has_password=False, browser_live=True)
        assert snap.to_dict() == {"has_username": True, "has_password": False, "browser_live": True}

    def test_stellar_to_dict_round_trips(self):
        snap = StellarHealthSnapshot(has_api=True, initialized=False)
        assert snap.to_dict() == {"has_api": True, "initialized": False}

    def test_x402_to_dict_round_trips(self):
        snap = X402HealthSnapshot(has_api=True, initialized=True, has_wallet=False)
        assert snap.to_dict() == {"has_api": True, "initialized": True, "has_wallet": False}

    @pytest.mark.parametrize(
        "snap",
        [
            DiscordHealthSnapshot(has_webhook=True, has_token=False, has_channel=False),
            TelegramHealthSnapshot(has_token=True, has_chat=True),
            XHealthSnapshot(has_username=True, has_password=True, browser_live=False),
            StellarHealthSnapshot(has_api=True, initialized=True),
            X402HealthSnapshot(has_api=True, initialized=True, has_wallet=True),
        ],
    )
    def test_snapshots_are_frozen(self, snap):
        field_name = dataclasses.fields(snap)[0].name
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(snap, field_name, not getattr(snap, field_name))


# ─── Real adapters return the typed snapshot ───────────────────────────────────


class TestDiscordAdapterSnapshot:
    def test_no_credentials(self):
        adapter = DiscordAdapter(_settings())
        snap = adapter.health_snapshot()
        assert snap == DiscordHealthSnapshot(has_webhook=False, has_token=False, has_channel=False)

    def test_webhook_only(self):
        adapter = DiscordAdapter(_settings(discord_webhook_url="https://discord.com/api/webhooks/x/y"))
        snap = adapter.health_snapshot()
        assert isinstance(snap, DiscordHealthSnapshot)
        assert snap.has_webhook is True
        assert snap.has_token is False

    def test_bot_token_and_channel(self):
        adapter = DiscordAdapter(_settings(discord_bot_token="tok", discord_channel_id="123"))
        snap = adapter.health_snapshot()
        assert snap == DiscordHealthSnapshot(has_webhook=False, has_token=True, has_channel=True)


class TestTelegramAdapterSnapshot:
    def test_no_credentials(self):
        adapter = TelegramAdapter(_settings())
        assert adapter.health_snapshot() == TelegramHealthSnapshot(has_token=False, has_chat=False)

    def test_fully_configured(self):
        adapter = TelegramAdapter(_settings(telegram_bot_token="tok", telegram_chat_id="123"))
        assert adapter.health_snapshot() == TelegramHealthSnapshot(has_token=True, has_chat=True)

    def test_partial_credentials(self):
        adapter = TelegramAdapter(_settings(telegram_bot_token="tok"))
        snap = adapter.health_snapshot()
        assert snap.has_token is True
        assert snap.has_chat is False


class TestXAdapterSnapshot:
    def test_no_credentials_no_browser(self):
        adapter = XAdapter(browser=None, config=XAdapterConfig(), secrets=_FakeSecrets())
        snap = adapter.health_snapshot()
        assert snap == XHealthSnapshot(has_username=False, has_password=False, browser_live=False)

    def test_credentials_and_live_browser(self):
        adapter = XAdapter(
            browser=_live_browser(),
            config=XAdapterConfig(username="agent"),
            secrets=_FakeSecrets(x_password="pw"),
        )
        snap = adapter.health_snapshot()
        assert snap == XHealthSnapshot(has_username=True, has_password=True, browser_live=True)

    def test_credentials_without_live_browser(self):
        adapter = XAdapter(
            browser=None,
            config=XAdapterConfig(username="agent"),
            secrets=_FakeSecrets(x_password="pw"),
        )
        snap = adapter.health_snapshot()
        assert snap.browser_live is False


class TestStellarKitSnapshot:
    def test_no_api_client(self):
        kit = StellarKit(api_client=None)
        assert kit.health_snapshot() == StellarHealthSnapshot(has_api=False, initialized=False)

    def test_configured_and_initialized(self):
        kit = StellarKit(api_client=MagicMock())
        kit._initialized = True
        assert kit.health_snapshot() == StellarHealthSnapshot(has_api=True, initialized=True)


class TestX402SignerSnapshot:
    def test_no_api_client(self):
        signer = X402Signer(api_client=None)
        assert signer.health_snapshot() == X402HealthSnapshot(
            has_api=False, initialized=False, has_wallet=False
        )

    def test_configured_initialized_with_wallet(self):
        signer = X402Signer(api_client=MagicMock())
        signer._initialized = True
        signer._wallet_address = "GD5J..."
        assert signer.health_snapshot() == X402HealthSnapshot(
            has_api=True, initialized=True, has_wallet=True
        )


# ─── SandboxedAdapter passthrough ───────────────────────────────────────────────


class TestSandboxedAdapterPassthrough:
    def test_forwards_typed_snapshot_unchanged(self):
        wrapped = DiscordAdapter(_settings(discord_bot_token="tok", discord_channel_id="123"))
        sandboxed = SandboxedAdapter(
            wrapped,
            manifest=MagicMock(),
            store=MagicMock(),
            semaphore=asyncio.Semaphore(1),
            owner_id="owner",
            breaker=MagicMock(),
        )
        snap = sandboxed.health_snapshot()
        assert snap == DiscordHealthSnapshot(has_webhook=False, has_token=True, has_channel=True)

    def test_forwards_empty_dict_when_wrapped_adapter_has_no_snapshot(self):
        wrapped = MagicMock(spec=["channel_name"])
        wrapped.channel_name = "Custom"
        sandboxed = SandboxedAdapter(
            wrapped,
            manifest=MagicMock(),
            store=MagicMock(),
            semaphore=asyncio.Semaphore(1),
            owner_id="owner",
            breaker=MagicMock(),
        )
        assert sandboxed.health_snapshot() == {}


# ─── Probes consume typed snapshots directly ────────────────────────────────────


class TestProbesConsumeTypedSnapshots:
    @pytest.mark.asyncio
    async def test_discord_probe_reads_typed_snapshot(self):
        adapter = DiscordAdapter(_settings(discord_bot_token="tok", discord_channel_id="123"))
        result = await DiscordProbe(adapter).probe()
        assert result.state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_telegram_probe_reads_typed_snapshot(self):
        adapter = TelegramAdapter(_settings(telegram_bot_token="tok"))
        result = await TelegramProbe(adapter).probe()
        assert result.state == AdapterState.DEGRADED

    @pytest.mark.asyncio
    async def test_x_probe_reads_typed_snapshot(self):
        adapter = XAdapter(
            browser=_live_browser(),
            config=XAdapterConfig(username="agent"),
            secrets=_FakeSecrets(x_password="pw"),
        )
        result = await XProbe(adapter).probe()
        assert result.state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_stellar_probe_reads_typed_snapshot(self):
        kit = StellarKit(api_client=MagicMock())
        kit._initialized = True
        result = await StellarPaymentProbe(kit).probe()
        assert result.state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_x402_probe_reads_typed_snapshot(self):
        signer = X402Signer(api_client=MagicMock())
        signer._initialized = True
        signer._wallet_address = "GD5J..."
        result = await X402PaymentProbe(signer).probe()
        assert result.state == AdapterState.HEALTHY


# ─── _snapshot_field / _snapshot_bool / _call_health_snapshot ──────────────────


class TestSnapshotFieldHelper:
    def test_reads_attribute_from_typed_dataclass(self):
        snap = DiscordHealthSnapshot(has_webhook=True, has_token=False, has_channel=False)
        assert _snapshot_field(snap, "has_webhook") is True

    def test_reads_key_from_legacy_dict(self):
        assert _snapshot_field({"has_webhook": True}, "has_webhook") is True

    def test_missing_field_on_dataclass_returns_sentinel(self):
        snap = DiscordHealthSnapshot(has_webhook=True, has_token=False, has_channel=False)
        assert _snapshot_field(snap, "nonexistent") is _MISSING

    def test_missing_key_in_dict_returns_sentinel(self):
        assert _snapshot_field({}, "has_webhook") is _MISSING

    def test_none_snapshot_returns_sentinel(self):
        assert _snapshot_field(None, "has_webhook") is _MISSING

    def test_unrecognised_type_returns_sentinel(self):
        assert _snapshot_field(object(), "has_webhook") is _MISSING

    def test_bool_falls_back_when_missing(self):
        assert _snapshot_bool(None, "has_webhook", "truthy-fallback") is True
        assert _snapshot_bool(None, "has_webhook", "") is False

    def test_bool_prefers_present_value_over_fallback(self):
        snap = DiscordHealthSnapshot(has_webhook=False, has_token=False, has_channel=False)
        # Field is present (False) — must not fall through to a truthy fallback.
        assert _snapshot_bool(snap, "has_webhook", "truthy-fallback") is False

    def test_call_health_snapshot_returns_none_when_missing(self):
        assert _call_health_snapshot(object()) is None

    def test_call_health_snapshot_returns_none_when_it_raises(self):
        adapter = MagicMock()
        adapter.health_snapshot.side_effect = RuntimeError("boom")
        assert _call_health_snapshot(adapter) is None


# ─── Boundary / malformed / dependency-failure inputs ───────────────────────────


class TestProbeResilienceToMalformedSnapshots:
    @pytest.mark.asyncio
    async def test_discord_probe_survives_snapshot_raising(self):
        adapter = MagicMock()
        adapter.channel_name = "Discord"
        adapter._webhook_url = "https://discord.com/api/webhooks/x/y"
        adapter._bot_token = ""
        adapter._channel_id = ""
        adapter.health_snapshot.side_effect = RuntimeError("boom")
        result = await DiscordProbe(adapter).probe()
        # Falls back to private-attribute introspection instead of raising.
        assert result.state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_discord_probe_survives_none_snapshot(self):
        adapter = MagicMock()
        adapter.channel_name = "Discord"
        adapter._webhook_url = ""
        adapter._bot_token = ""
        adapter._channel_id = ""
        adapter.health_snapshot = lambda: None
        result = await DiscordProbe(adapter).probe()
        assert result.state == AdapterState.DISABLED

    @pytest.mark.asyncio
    async def test_stellar_probe_survives_unrecognised_snapshot_type(self):
        kit = MagicMock()
        kit._api = MagicMock()
        kit._initialized = True
        kit.health_snapshot = lambda: "not-a-snapshot"
        result = await StellarPaymentProbe(kit).probe()
        assert result.state == AdapterState.HEALTHY

    @pytest.mark.asyncio
    async def test_legacy_dict_snapshot_still_accepted(self):
        """Adapters not yet migrated to the typed contract keep working unmodified."""
        adapter = MagicMock()
        adapter.channel_name = "Telegram"
        adapter._bot_token = ""
        adapter._chat_id = ""
        adapter.health_snapshot = lambda: {"has_token": True, "has_chat": True}
        result = await TelegramProbe(adapter).probe()
        assert result.state == AdapterState.HEALTHY
