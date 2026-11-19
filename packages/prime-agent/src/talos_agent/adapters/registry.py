"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from talos_agent.adapters.base import BaseSocialAdapter

if TYPE_CHECKING:
    from talos_agent.adapters.capability import AdapterSandbox

logger = logging.getLogger(__name__)


class AdapterRegistry:
    """Holds all registered channel adapters and routes publishing calls.

    Duplicate registration behaviour is controlled by the ``on_duplicate``
    constructor parameter:

    * ``"raise"`` (default) — raise :class:`ValueError` immediately so
      mis-configuration is caught at startup.
    * ``"warn"``            — log a warning and keep the *existing* adapter
      (the duplicate is silently dropped).
    * ``"skip"``            — silently ignore the duplicate and keep the
      existing adapter without any log output.

    Use :meth:`replace` for intentional, deliberate adapter swaps.
    """

    #: Accepted values for the ``on_duplicate`` parameter.
    _VALID_ON_DUPLICATE = frozenset({"raise", "warn", "skip"})

    def __init__(
        self,
        sandbox: AdapterSandbox | None = None,
        *,
        on_duplicate: str = "raise",
    ) -> None:
        if on_duplicate not in self._VALID_ON_DUPLICATE:
            raise ValueError(
                f"on_duplicate must be one of {sorted(self._VALID_ON_DUPLICATE)!r}, "
                f"got {on_duplicate!r}"
            )
        self._adapters: dict[str, BaseSocialAdapter] = {}
        self._sandbox = sandbox
        self._on_duplicate = on_duplicate

    # ── Registration ─────────────────────────────────────────────────

    def register(self, adapter: BaseSocialAdapter) -> None:
        """Register *adapter* under its ``channel_name`` (case-insensitive key).

        Raises :class:`ValueError` (or logs / skips, depending on
        ``on_duplicate``) when a channel with the same key is already
        registered.  Use :meth:`replace` for intentional swaps.
        """
        if self._sandbox is not None:
            adapter = self._sandbox.wrap(adapter)

        key = adapter.channel_name.lower()

        if key in self._adapters:
            existing = self._adapters[key]
            msg = (
                f"Duplicate adapter registration for channel {key!r}: "
                f"an adapter of type {type(existing).__name__!r} is already "
                f"registered. Use replace() for intentional swaps."
            )
            if self._on_duplicate == "raise":
                raise ValueError(msg)
            elif self._on_duplicate == "warn":
                logger.warning(msg)
                return  # keep the existing adapter
            else:  # "skip"
                return  # silently ignore

        self._adapters[key] = adapter

    def replace(self, adapter: BaseSocialAdapter) -> BaseSocialAdapter | None:
        """Intentionally swap out the adapter for *adapter.channel_name*.

        Unlike :meth:`register`, ``replace`` never raises on a pre-existing
        entry — it is the explicit, deliberate path for hot-swapping adapters
        at runtime (e.g. rotating credentials or switching environments).

        Parameters
        ----------
        adapter:
            The new adapter to install.  Its ``channel_name`` determines
            which key is replaced.

        Returns
        -------
        BaseSocialAdapter | None
            The previously registered adapter for that channel, or ``None``
            if no adapter was registered beforehand.
        """
        if self._sandbox is not None:
            adapter = self._sandbox.wrap(adapter)

        key = adapter.channel_name.lower()
        previous = self._adapters.get(key)
        self._adapters[key] = adapter
        return previous

    # ── Lookup ───────────────────────────────────────────────────────

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
