"""Adapter diagnostics — capability negotiation report per enabled adapter.

Each registered adapter exposes a :class:`CapabilityReport` that lists the
operations it supports and the configuration it requires.  Adapters that are
not fully configured are excluded from the set of capabilities that autonomous
tool selection may use.

Usage
-----
Build a full capability report from a registry::

    from talos_agent.adapters.diagnostics import CapabilityReporter

    reporter = CapabilityReporter(registry)
    report = reporter.report()

    # Inspect what autonomous tools may use
    for name, entry in report.available.items():
        print(name, entry.supported_operations)

Report structure
----------------
available   — adapters that are configured and safe for autonomous selection.
unavailable — adapters whose required configuration is missing or incomplete.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from talos_agent.adapters.registry import AdapterRegistry


# ── Required-configuration descriptor ────────────────────────────────────────


@dataclass
class RequiredConfig:
    """Describes the environment variables an adapter needs to be functional."""

    env_vars: list[str] = field(default_factory=list)
    """Names of required environment variables (e.g. ``["DISCORD_WEBHOOK_URL"]``)."""

    optional_vars: list[str] = field(default_factory=list)
    """Names of optional variables that unlock additional features."""

    def to_dict(self) -> dict:
        return {
            "env_vars": self.env_vars,
            "optional_vars": self.optional_vars,
        }


# ── Per-adapter capability entry ──────────────────────────────────────────────


@dataclass
class CapabilityEntry:
    """Capability negotiation result for one adapter."""

    adapter: str
    """Canonical adapter name."""

    supported_operations: list[str] = field(default_factory=list)
    """Operations this adapter can perform (e.g. ``["post", "reply", "search"]``)."""

    required_config: RequiredConfig = field(default_factory=RequiredConfig)
    """What configuration the adapter needs."""

    available_for_autonomous_use: bool = False
    """``True`` only when the adapter is fully configured and safe to include in
    autonomous tool selection."""

    detail: str = ""
    """Human-readable explanation of the availability decision."""

    def to_dict(self) -> dict:
        return {
            "adapter": self.adapter,
            "supported_operations": self.supported_operations,
            "required_config": self.required_config.to_dict(),
            "available_for_autonomous_use": self.available_for_autonomous_use,
            "detail": self.detail,
        }


# ── Aggregate capability report ───────────────────────────────────────────────


@dataclass
class CapabilityReport:
    """Capability negotiation report across all registered adapters."""

    available: dict[str, CapabilityEntry] = field(default_factory=dict)
    """Adapters whose capabilities may be used by autonomous tool selection."""

    unavailable: dict[str, CapabilityEntry] = field(default_factory=dict)
    """Adapters that are registered but cannot be used autonomously."""

    generated_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "available": {k: v.to_dict() for k, v in self.available.items()},
            "unavailable": {k: v.to_dict() for k, v in self.unavailable.items()},
            "generated_at": self.generated_at.isoformat(),
        }


# ── Per-adapter negotiation functions ────────────────────────────────────────


def _discord_entry(adapter) -> CapabilityEntry:
    """Build a :class:`CapabilityEntry` for a DiscordAdapter instance."""
    has_webhook = bool(getattr(adapter, "_webhook_url", ""))
    has_token = bool(getattr(adapter, "_bot_token", ""))
    has_channel = bool(getattr(adapter, "_channel_id", ""))
    configured = has_webhook or (has_token and has_channel)

    ops = ["post"]
    if has_token and has_channel:
        ops += ["reply", "get_mentions", "search", "get_post_performance", "get_profile_stats"]

    req = RequiredConfig(
        env_vars=["DISCORD_WEBHOOK_URL"],
        optional_vars=["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_GUILD_ID"],
    )

    if configured:
        detail = "webhook configured" if has_webhook else "bot token + channel ID configured"
    else:
        detail = (
            "Not configured. Set DISCORD_WEBHOOK_URL or "
            "DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID."
        )

    return CapabilityEntry(
        adapter=adapter.channel_name,
        supported_operations=ops,
        required_config=req,
        available_for_autonomous_use=configured,
        detail=detail,
    )


def _telegram_entry(adapter) -> CapabilityEntry:
    """Build a :class:`CapabilityEntry` for a TelegramAdapter instance."""
    has_token = bool(getattr(adapter, "_bot_token", ""))
    has_chat = bool(getattr(adapter, "_chat_id", ""))
    configured = has_token and has_chat

    ops = ["post", "reply"] if configured else []

    req = RequiredConfig(
        env_vars=["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
        optional_vars=[],
    )

    detail = (
        "bot token and chat ID configured"
        if configured
        else "Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
    )

    return CapabilityEntry(
        adapter=adapter.channel_name,
        supported_operations=ops,
        required_config=req,
        available_for_autonomous_use=configured,
        detail=detail,
    )


def _x_entry(adapter) -> CapabilityEntry:
    """Build a :class:`CapabilityEntry` for an XAdapter instance."""
    settings = getattr(adapter, "_settings", None)
    has_username = bool(getattr(settings, "x_username", ""))
    has_password = bool(getattr(settings, "x_password", ""))
    configured = has_username and has_password

    ops = ["post", "reply", "get_mentions", "search", "get_post_performance", "get_profile_stats"]

    req = RequiredConfig(
        env_vars=["X_USERNAME", "X_PASSWORD"],
        optional_vars=["X_EMAIL"],
    )

    detail = (
        "X credentials configured"
        if configured
        else "Not configured. Set X_USERNAME and X_PASSWORD."
    )

    return CapabilityEntry(
        adapter=adapter.channel_name,
        supported_operations=ops if configured else [],
        required_config=req,
        available_for_autonomous_use=configured,
        detail=detail,
    )


# ── Reporter ──────────────────────────────────────────────────────────────────

_ENTRY_BUILDERS = {
    "discord": _discord_entry,
    "telegram": _telegram_entry,
    "x": _x_entry,
}


class CapabilityReporter:
    """Builds a :class:`CapabilityReport` from an :class:`AdapterRegistry`.

    Adapters whose capabilities are unavailable are kept out of the
    ``available`` set so that autonomous tool selection never attempts to call
    them.

    Parameters
    ----------
    registry:
        The :class:`~talos_agent.adapters.registry.AdapterRegistry` to inspect.
    """

    def __init__(self, registry: "AdapterRegistry") -> None:
        self._registry = registry

    def report(self) -> CapabilityReport:
        """Return the current :class:`CapabilityReport` for all registered adapters."""
        available: dict[str, CapabilityEntry] = {}
        unavailable: dict[str, CapabilityEntry] = {}

        for key, adapter in self._registry._adapters.items():
            builder = _ENTRY_BUILDERS.get(key)
            if builder is not None:
                entry = builder(adapter)
            else:
                # Unknown adapter type — build a generic entry from capabilities
                entry = _generic_entry(adapter)

            if entry.available_for_autonomous_use:
                available[entry.adapter] = entry
            else:
                unavailable[entry.adapter] = entry

        return CapabilityReport(available=available, unavailable=unavailable)


def _generic_entry(adapter) -> CapabilityEntry:
    """Fallback entry builder for adapter types not explicitly handled."""
    try:
        caps = adapter.get_capabilities()
        ops = ["post", "reply"]
        if getattr(caps, "supports_search", False):
            ops.append("search")
        if getattr(caps, "supports_analytics", False):
            ops += ["get_post_performance", "get_profile_stats"]
        available = True
        detail = "adapter registered"
    except Exception as exc:
        ops = []
        available = False
        detail = f"Could not inspect capabilities: {exc}"

    return CapabilityEntry(
        adapter=adapter.channel_name,
        supported_operations=ops,
        required_config=RequiredConfig(),
        available_for_autonomous_use=available,
        detail=detail,
    )
