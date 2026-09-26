"""Typed adapter health snapshots.

Every adapter/payment kit exposes a side-effect-free ``health_snapshot()``
method that reports its in-process readiness (credentials present, proxy
initialised, browser session live, etc.) to :mod:`talos_agent.adapters.health`.
Historically this returned an ad-hoc ``dict[str, bool]`` with no shared type,
so callers had to duck-type against string keys that only failed at runtime
when misspelled or renamed.

The dataclasses below give each adapter a concrete, statically-checkable
return type instead. They carry no behavior beyond ``to_dict()`` (for
logging/CLI/telemetry serialization), matching the ``@dataclass`` + ``to_dict``
convention already used by :class:`~talos_agent.adapters.health.ProbeResult`,
:class:`~talos_agent.wal_health.WalHealthReport`, and
:class:`~talos_agent.circuit_breaker.CircuitBreakerMetrics`.

Backward compatibility: adapters that have not been migrated yet (or
third-party/custom adapters registered at runtime) may still return a plain
``dict[str, bool]`` from ``health_snapshot()``. The probes in
:mod:`talos_agent.adapters.health` accept both shapes — see
``_snapshot_field`` there — so this is an additive, non-breaking change.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class DiscordHealthSnapshot:
    """Readiness snapshot for :class:`~talos_agent.adapters.discord.DiscordAdapter`."""

    has_webhook: bool
    has_token: bool
    has_channel: bool
    reconnect_enabled: bool = False
    consecutive_failures: int = 0

    def to_dict(self) -> dict[str, bool | int]:
        return asdict(self)


@dataclass(frozen=True)
class TelegramHealthSnapshot:
    """Readiness snapshot for :class:`~talos_agent.adapters.telegram.TelegramAdapter`."""

    has_token: bool
    has_chat: bool

    def to_dict(self) -> dict[str, bool]:
        return asdict(self)


@dataclass(frozen=True)
class XHealthSnapshot:
    """Readiness snapshot for :class:`~talos_agent.adapters.x.XAdapter`."""

    has_username: bool
    has_password: bool
    browser_live: bool

    def to_dict(self) -> dict[str, bool]:
        return asdict(self)


@dataclass(frozen=True)
class StellarHealthSnapshot:
    """Readiness snapshot for :class:`~talos_agent.payments.stellar_kit.StellarKit`."""

    has_api: bool
    initialized: bool

    def to_dict(self) -> dict[str, bool]:
        return asdict(self)


@dataclass(frozen=True)
class X402HealthSnapshot:
    """Readiness snapshot for :class:`~talos_agent.payments.x402_signer.X402Signer`."""

    has_api: bool
    initialized: bool
    has_wallet: bool

    def to_dict(self) -> dict[str, bool]:
        return asdict(self)


AdapterHealthSnapshot = (
    DiscordHealthSnapshot
    | TelegramHealthSnapshot
    | XHealthSnapshot
    | StellarHealthSnapshot
    | X402HealthSnapshot
)
"""Union of every typed adapter health snapshot. Used for type hints on
``health_snapshot()`` implementations and their consumers."""
