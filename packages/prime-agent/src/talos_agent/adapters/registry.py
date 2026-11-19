"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

from talos_agent.adapters.base import BaseSocialAdapter
from talos_agent.adapters.diagnostics import AdapterPauseController, PauseReport


class AdapterRegistry:
    """Holds all registered channel adapters and routes publishing calls.

    A :class:`~talos_agent.adapters.diagnostics.AdapterPauseController` is
    embedded so that callers can pause a single adapter's publications without
    affecting any other adapter.  In-flight sends that were started before the
    pause was issued are tracked via the controller and can be resolved once
    their outcome is known.
    """

    def __init__(self) -> None:
        self._adapters: dict[str, BaseSocialAdapter] = {}
        self.pause_controller: AdapterPauseController = AdapterPauseController()

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

    # ── Pause helpers ─────────────────────────────────────────────────────────

    def pause(self, channel: str) -> None:
        """Stop new publications for *channel*.

        The pause is adapter-specific: all other registered adapters continue
        to operate normally.  Calling pause on an already-paused adapter is a
        no-op.
        """
        self.pause_controller.pause(channel)

    def resume(self, channel: str) -> None:
        """Resume publications for *channel*."""
        self.pause_controller.resume(channel)

    def is_paused(self, channel: str) -> bool:
        """Return ``True`` if *channel* is currently paused."""
        return self.pause_controller.is_paused(channel)

    def pause_report(self, channel: str) -> PauseReport:
        """Return the in-flight outcome report for *channel*.

        The report lists every send recorded while the adapter was pausing and
        its resolved outcome (if known), plus the current pause state.
        """
        return self.pause_controller.in_flight_report(channel)

    def __len__(self) -> int:
        return len(self._adapters)
