"""Social channel adapters — modular publishing interface."""

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.discord import DiscordAdapter
from talos_agent.adapters.registry import AdapterRegistry

__all__ = [
    "BaseSocialAdapter",
    "ChannelCapabilities",
    "PublishResult",
    "AdapterRegistry",
    "DiscordAdapter",
]
