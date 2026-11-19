"""AdapterRegistry — maps channel names to BaseSocialAdapter instances."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import logging
from typing import TYPE_CHECKING, Any

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities

if TYPE_CHECKING:
    from talos_agent.adapters.capability import AdapterSandbox

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CapabilityChange:
    """Differences between old and new capabilities for an adapter channel."""

    before: dict[str, Any]
    after: dict[str, Any]
    differences: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "before": dict(self.before),
            "after": dict(self.after),
            "differences": dict(self.differences),
        }


@dataclass(frozen=True)
class AdapterReloadPreview:
    """Preview of changes and impact when reloading adapter configuration."""

    valid: bool
    added_channels: list[str] = field(default_factory=list)
    removed_channels: list[str] = field(default_factory=list)
    modified_channels: list[str] = field(default_factory=list)
    unchanged_channels: list[str] = field(default_factory=list)
    capability_diff: dict[str, CapabilityChange] = field(default_factory=dict)
    affected_scheduled_tasks: list[str] = field(default_factory=list)
    validation_errors: list[str] = field(default_factory=list)

    @property
    def has_changes(self) -> bool:
        """Return True if any channel was added, removed, or modified."""
        return bool(self.added_channels or self.removed_channels or self.modified_channels)

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "has_changes": self.has_changes,
            "added_channels": list(self.added_channels),
            "removed_channels": list(self.removed_channels),
            "modified_channels": list(self.modified_channels),
            "unchanged_channels": list(self.unchanged_channels),
            "capability_diff": {k: v.to_dict() for k, v in self.capability_diff.items()},
            "affected_scheduled_tasks": list(self.affected_scheduled_tasks),
            "validation_errors": list(self.validation_errors),
        }


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

    # ── Configuration Reload Preview ─────────────────────────────────

    def preview_reload(
        self,
        candidate: Any,
    ) -> AdapterReloadPreview:
        """Preview changes and affected tasks from a candidate adapter configuration.

        Validates the candidate without connecting to external networks or
        using external credentials.

        Accepts:
        - An :class:`AdapterRegistry` instance
        - An iterable of :class:`BaseSocialAdapter` instances
        - A mapping of channel name -> :class:`BaseSocialAdapter` | :class:`ChannelCapabilities` | dict
        """
        validation_errors: list[str] = []
        candidate_channels: dict[str, tuple[str, dict[str, Any]]] = {}

        # 1. Parse and validate candidate without invoking external credentials
        try:
            if candidate is None:
                validation_errors.append("Candidate configuration cannot be None")
            elif isinstance(candidate, AdapterRegistry):
                for ch in candidate.available_channels():
                    adapter = candidate.get(ch)
                    if adapter is None:
                        continue
                    try:
                        caps = adapter.get_capabilities()
                        candidate_channels[ch.lower()] = (
                            adapter.channel_name,
                            asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                        )
                    except Exception as exc:
                        validation_errors.append(f"Channel {ch!r} failed capability extraction: {exc}")
            elif isinstance(candidate, (list, tuple, set)):
                seen_keys: set[str] = set()
                for idx, item in enumerate(candidate):
                    if not isinstance(item, BaseSocialAdapter):
                        validation_errors.append(
                            f"Candidate item at index {idx} is not a BaseSocialAdapter (got {type(item).__name__})"
                        )
                        continue
                    ch_name = getattr(item, "channel_name", None)
                    if not ch_name or not isinstance(ch_name, str):
                        validation_errors.append(
                            f"Candidate adapter at index {idx} has invalid channel_name {ch_name!r}"
                        )
                        continue
                    key = ch_name.lower()
                    if key in seen_keys:
                        validation_errors.append(f"Duplicate channel {ch_name!r} in candidate adapter list")
                        continue
                    seen_keys.add(key)
                    try:
                        caps = item.get_capabilities()
                        candidate_channels[key] = (
                            item.channel_name,
                            asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                        )
                    except Exception as exc:
                        validation_errors.append(f"Channel {ch_name!r} failed capability extraction: {exc}")
            elif isinstance(candidate, dict):
                for raw_name, item in candidate.items():
                    if not isinstance(raw_name, str) or not raw_name.strip():
                        validation_errors.append(f"Invalid channel identifier in candidate map: {raw_name!r}")
                        continue
                    key = raw_name.strip().lower()
                    if key in candidate_channels:
                        validation_errors.append(f"Duplicate channel key in candidate map: {raw_name!r}")
                        continue

                    if isinstance(item, BaseSocialAdapter):
                        try:
                            caps = item.get_capabilities()
                            candidate_channels[key] = (
                                item.channel_name,
                                asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__),
                            )
                        except Exception as exc:
                            validation_errors.append(f"Channel {raw_name!r} failed capability extraction: {exc}")
                    elif isinstance(item, ChannelCapabilities):
                        candidate_channels[key] = (raw_name, asdict(item))
                    elif isinstance(item, dict):
                        # Candidate is directly a capabilities dict or config map
                        candidate_channels[key] = (raw_name, dict(item))
                    else:
                        validation_errors.append(
                            f"Channel {raw_name!r} has invalid candidate type {type(item).__name__}"
                        )
            else:
                validation_errors.append(
                    f"Unsupported candidate type: {type(candidate).__name__}. "
                    "Expected AdapterRegistry, list/tuple of BaseSocialAdapter, or mapping."
                )
        except Exception as exc:
            validation_errors.append(f"Unexpected candidate validation error: {exc}")

        # 2. Extract current capabilities
        current_channels: dict[str, tuple[str, dict[str, Any]]] = {}
        for ch in self.available_channels():
            adapter = self.get(ch)
            if adapter is not None:
                try:
                    caps = adapter.get_capabilities()
                    caps_dict = asdict(caps) if hasattr(caps, "__dataclass_fields__") else dict(caps.__dict__)
                except Exception:
                    caps_dict = {}
                current_channels[ch.lower()] = (adapter.channel_name, caps_dict)

        # If invalid candidate, return failed preview immediately
        if validation_errors:
            return AdapterReloadPreview(
                valid=False,
                validation_errors=validation_errors,
            )

        # 3. Compute capability differences
        added_channels: list[str] = []
        removed_channels: list[str] = []
        modified_channels: list[str] = []
        unchanged_channels: list[str] = []
        capability_diff: dict[str, CapabilityChange] = {}

        curr_keys = set(current_channels.keys())
        cand_keys = set(candidate_channels.keys())

        # Added channels
        for key in sorted(cand_keys - curr_keys):
            ch_name, caps = candidate_channels[key]
            added_channels.append(ch_name)
            capability_diff[ch_name] = CapabilityChange(
                before={},
                after=caps,
                differences={k: {"before": None, "after": v} for k, v in caps.items()},
            )

        # Removed channels
        for key in sorted(curr_keys - cand_keys):
            ch_name, caps = current_channels[key]
            removed_channels.append(ch_name)
            capability_diff[ch_name] = CapabilityChange(
                before=caps,
                after={},
                differences={k: {"before": v, "after": None} for k, v in caps.items()},
            )

        # Existing in both: check modifications
        for key in sorted(curr_keys & cand_keys):
            curr_name, curr_caps = current_channels[key]
            cand_name, cand_caps = candidate_channels[key]
            display_name = cand_name

            all_field_names = set(curr_caps.keys()) | set(cand_caps.keys())
            diffs: dict[str, dict[str, Any]] = {}
            for field_name in sorted(all_field_names):
                val_before = curr_caps.get(field_name)
                val_after = cand_caps.get(field_name)
                if val_before != val_after:
                    diffs[field_name] = {"before": val_before, "after": val_after}

            if diffs:
                modified_channels.append(display_name)
                capability_diff[display_name] = CapabilityChange(
                    before=curr_caps,
                    after=cand_caps,
                    differences=diffs,
                )
            else:
                unchanged_channels.append(display_name)

        # 4. Determine affected scheduled tasks
        # Known tasks in prime-agent scheduler:
        # - "agent_cycle": consumes all active publishing adapters & capabilities
        # - "learning_cycle": consumes active channels & capabilities for review/learning
        # - "telemetry_log": collects health snapshots across all configured adapters
        # - "telegram_queue": worker task for Telegram queue rate-limiting
        affected_tasks_set: set[str] = set()

        any_channel_changes = bool(added_channels or removed_channels or modified_channels)
        if any_channel_changes:
            affected_tasks_set.add("agent_cycle")
            affected_tasks_set.add("learning_cycle")
            affected_tasks_set.add("telemetry_log")

        # Telegram-specific tasks
        has_curr_telegram = "telegram" in curr_keys
        has_cand_telegram = "telegram" in cand_keys
        if has_curr_telegram != has_cand_telegram or (
            has_cand_telegram and "telegram" in (k.lower() for k in modified_channels)
        ):
            affected_tasks_set.add("telegram_queue")

        # Order affected tasks deterministically
        task_order = [
            "agent_cycle",
            "learning_cycle",
            "telemetry_log",
            "telegram_queue",
        ]
        affected_scheduled_tasks = [t for t in task_order if t in affected_tasks_set]

        return AdapterReloadPreview(
            valid=True,
            added_channels=added_channels,
            removed_channels=removed_channels,
            modified_channels=modified_channels,
            unchanged_channels=unchanged_channels,
            capability_diff=capability_diff,
            affected_scheduled_tasks=affected_scheduled_tasks,
            validation_errors=[],
        )
