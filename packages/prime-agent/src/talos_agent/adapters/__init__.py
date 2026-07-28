"""Social channel adapters — modular publishing interface."""

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.capability import (
    AdapterCapabilityManifest,
    AdapterResourceLimits,
    AdapterSandbox,
    CapabilityDeniedError,
    NetworkRule,
)
from talos_agent.adapters.discord import DiscordAdapter, DiscordAdapterConfig
from talos_agent.adapters.health import (
    AdapterHealthReporter,
    AdapterProbe,
    AdapterState,
    BrowserSessionProbe,
    DiscordProbe,
    HealthReport,
    ProbeResult,
    TelegramProbe,
    XProbe,
)
from talos_agent.adapters.registry import AdapterRegistry
from talos_agent.adapters.telegram import TelegramAdapter  # noqa: F401
from talos_agent.adapters.storage import (
    BaseStorageAdapter,
    LocalStorageAdapter,
    MemoryStorageAdapter,
    VerifiedCheckpointStorage,
    StorageError,
    StorageValidationError,
    StorageVerificationError,
    StorageProviderError,
)

__all__ = [
    "BaseSocialAdapter",
    "ChannelCapabilities",
    "PublishResult",
    "AdapterRegistry",
    "AdapterCapabilityManifest",
    "AdapterResourceLimits",
    "AdapterSandbox",
    "CapabilityDeniedError",
    "NetworkRule",
    "DiscordAdapter",
    "DiscordAdapterConfig",
    "TelegramAdapter",
    "TelegramAdapterConfig",
    "XAdapterConfig",
    # Health probes
    "AdapterState",
    "ProbeResult",
    "AdapterProbe",
    "DiscordProbe",
    "TelegramProbe",
    "XProbe",
    "BrowserSessionProbe",
    "HealthReport",
    "AdapterHealthReporter",
    # Storage adapters and coordinator
    "BaseStorageAdapter",
    "LocalStorageAdapter",
    "MemoryStorageAdapter",
    "VerifiedCheckpointStorage",
    "StorageError",
    "StorageValidationError",
    "StorageVerificationError",
    "StorageProviderError",
]

