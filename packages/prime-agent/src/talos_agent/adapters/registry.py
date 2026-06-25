"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

from talos_agent.adapters.base import BaseSocialAdapter


class AdapterRegistry:
    """Holds all registered channel adapters and routes publishing calls."""

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

    def __len__(self) -> int:
        return len(self._adapters)
