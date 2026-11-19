"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

from talos_agent.adapters.base import BaseSocialAdapter
from talos_agent.adapters.diagnostics import CapabilityReport, CapabilityReporter


class AdapterRegistry:
    """Holds all registered channel adapters and routes publishing calls.

    A :class:`~talos_agent.adapters.diagnostics.CapabilityReporter` is
    embedded so callers can retrieve a full capability negotiation report and
    keep unavailable adapters out of autonomous tool selection.
    """

    def __init__(self) -> None:
        self._adapters: dict[str, BaseSocialAdapter] = {}

    def register(self, adapter: BaseSocialAdapter) -> None:
        """Register an adapter under its channel_name (case-insensitive key)."""
        self._adapters[adapter.channel_name.lower()] = adapter

    def get(self, channel: str) -> BaseSocialAdapter | None:
        return self._adapters.get(channel.lower())

    def available_channels(self) -> list[str]:
        return [a.channel_name for a in self._adapters.values()]

    def capabilities(self) -> dict[str, dict]:
        return {
            a.channel_name: a.get_capabilities().__dict__
            for a in self._adapters.values()
        }

    # ── Capability negotiation ────────────────────────────────────────────────

    def capability_report(self) -> CapabilityReport:
        """Return the full capability negotiation report for all adapters.

        The report separates adapters into ``available`` (fully configured and
        safe for autonomous tool selection) and ``unavailable`` (missing
        required configuration).  Callers should consult ``report.available``
        before passing adapter capabilities to the agent's tool chooser.
        """
        return CapabilityReporter(self).report()

    def __len__(self) -> int:
        return len(self._adapters)
