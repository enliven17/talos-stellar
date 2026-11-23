"""Tests for AdapterRegistry duplicate-registration guard and replace() method.

Covers:
- Happy path: registering a single adapter succeeds.
- Idempotent re-registration of the same adapter, or of a replacement with
  identical capabilities, is accepted and keeps the first instance.
- Duplicate registration with conflicting capabilities raises
  AdapterCapabilityConflictError (default on_duplicate="raise").
- Conflicting registration logs a warning and keeps the existing adapter
  (on_duplicate="warn").
- Conflicting registration is silently skipped (on_duplicate="skip").
- replace() swaps adapters deliberately without raising.
- replace() returns the previously registered adapter.
- replace() on a previously empty slot returns None.
- on_duplicate validation raises ValueError for unknown values.
- Case-insensitive key handling is preserved across all code paths.
- available_channels() and capabilities() reflect the correct state.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities
from talos_agent.adapters.registry import AdapterCapabilityConflictError, AdapterRegistry


# ── Minimal stub adapter ─────────────────────────────────────────────────────


def _make_adapter(
    channel_name: str, *, char_limit: int | None = None
) -> BaseSocialAdapter:
    """Create a lightweight mock that satisfies the BaseSocialAdapter interface."""
    adapter = MagicMock(spec=BaseSocialAdapter)
    adapter.channel_name = channel_name
    caps = ChannelCapabilities(char_limit=char_limit)
    adapter.get_capabilities.return_value = caps
    return adapter


# ── register() ───────────────────────────────────────────────────────────────


class TestRegisterHappyPath:
    def test_single_adapter_is_stored(self):
        registry = AdapterRegistry()
        adapter = _make_adapter("X")
        registry.register(adapter)
        assert registry.get("x") is adapter
        assert len(registry) == 1

    def test_two_different_channels_are_both_stored(self):
        registry = AdapterRegistry()
        x = _make_adapter("X")
        telegram = _make_adapter("Telegram")
        registry.register(x)
        registry.register(telegram)
        assert len(registry) == 2
        assert registry.get("x") is x
        assert registry.get("telegram") is telegram

    def test_channel_name_lookup_is_case_insensitive(self):
        registry = AdapterRegistry()
        adapter = _make_adapter("LinkedIn")
        registry.register(adapter)
        assert registry.get("linkedin") is adapter
        assert registry.get("LINKEDIN") is adapter
        assert registry.get("LinkedIn") is adapter


class TestRegisterIdempotent:
    """Re-registering the same capability set must not be treated as a conflict."""

    def test_same_instance_is_idempotent(self):
        registry = AdapterRegistry()
        adapter = _make_adapter("X")
        registry.register(adapter)
        registry.register(adapter)
        assert registry.get("x") is adapter
        assert len(registry) == 1

    def test_same_capabilities_are_idempotent_and_keep_first_instance(self):
        registry = AdapterRegistry()
        original = _make_adapter("X", char_limit=280)
        duplicate = _make_adapter("X", char_limit=280)
        registry.register(original)
        registry.register(duplicate)
        assert registry.get("x") is original
        assert len(registry) == 1

    def test_idempotent_registration_is_case_insensitive(self):
        registry = AdapterRegistry()
        original = _make_adapter("Telegram")
        registry.register(original)
        registry.register(_make_adapter("telegram"))
        assert registry.get("telegram") is original
        assert len(registry) == 1

    def test_idempotent_registration_is_checked_at_startup_before_lookup(self):
        """Registration runs during startup wiring, before any task can publish."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("Discord", char_limit=2000))
        registry.register(_make_adapter("Discord", char_limit=2000))
        assert registry.available_channels() == ["Discord"]

    def test_sandbox_wrapped_duplicate_is_idempotent(self):
        """The sandbox wraps each registration in a new proxy instance."""

        def wrap(inner):
            proxy = MagicMock(spec=BaseSocialAdapter)
            proxy.channel_name = inner.channel_name
            proxy.get_capabilities = inner.get_capabilities
            return proxy

        sandbox = MagicMock()
        sandbox.wrap.side_effect = wrap
        registry = AdapterRegistry(sandbox)
        registry.register(_make_adapter("X", char_limit=280))
        registry.register(_make_adapter("X", char_limit=280))
        assert len(registry) == 1
        assert registry.get("x").get_capabilities() == ChannelCapabilities(char_limit=280)

    def test_sandbox_wrapped_capability_conflict_still_raises(self):
        sandbox = MagicMock()
        sandbox.wrap.side_effect = lambda inner: inner
        registry = AdapterRegistry(sandbox)
        registry.register(_make_adapter("X", char_limit=280))
        with pytest.raises(AdapterCapabilityConflictError):
            registry.register(_make_adapter("X", char_limit=500))


class TestRegisterDuplicateRaise:
    """Default on_duplicate="raise" behaviour for capability conflicts."""

    def test_conflicting_duplicate_raises_capability_conflict(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        with pytest.raises(AdapterCapabilityConflictError, match="Duplicate adapter registration"):
            registry.register(_make_adapter("X", char_limit=500))

    def test_conflict_error_is_a_value_error(self):
        """Existing callers that catch ValueError keep working."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        with pytest.raises(ValueError):
            registry.register(_make_adapter("X", char_limit=500))

    def test_error_message_contains_channel_name(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("Telegram", char_limit=280))
        with pytest.raises(ValueError, match="telegram"):
            registry.register(_make_adapter("Telegram", char_limit=500))

    def test_error_message_mentions_conflicting_capabilities(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        with pytest.raises(ValueError, match="capabilities"):
            registry.register(_make_adapter("X", char_limit=500))

    def test_error_message_mentions_replace(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("Discord", char_limit=2000))
        with pytest.raises(ValueError, match="replace"):
            registry.register(_make_adapter("Discord", char_limit=4000))

    def test_first_adapter_is_unchanged_after_failed_register(self):
        """The existing adapter must not be touched on failure."""
        registry = AdapterRegistry()
        original = _make_adapter("X", char_limit=280)
        registry.register(original)
        with pytest.raises(ValueError):
            registry.register(_make_adapter("X", char_limit=500))
        assert registry.get("x") is original

    def test_case_insensitive_duplicate_raises(self):
        """'X' and 'x' share the same key and must trigger the guard."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        with pytest.raises(ValueError, match="Duplicate"):
            registry.register(_make_adapter("x", char_limit=500))


class TestRegisterDuplicateWarn:
    def test_warn_mode_does_not_raise_on_conflict(self):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X", char_limit=280))
        # Must not raise
        registry.register(_make_adapter("X", char_limit=500))

    def test_warn_mode_keeps_existing_adapter(self):
        registry = AdapterRegistry(on_duplicate="warn")
        original = _make_adapter("X", char_limit=280)
        registry.register(original)
        registry.register(_make_adapter("X", char_limit=500))
        assert registry.get("x") is original

    def test_warn_mode_emits_log_warning_on_conflict(self, caplog):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X", char_limit=280))
        with caplog.at_level(logging.WARNING, logger="talos_agent.adapters.registry"):
            registry.register(_make_adapter("X", char_limit=500))
        assert any("Duplicate" in r.message for r in caplog.records)

    def test_warn_mode_does_not_log_for_idempotent_registration(self, caplog):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X"))
        with caplog.at_level(logging.DEBUG, logger="talos_agent.adapters.registry"):
            registry.register(_make_adapter("X"))
        assert len(caplog.records) == 0

    def test_warn_mode_count_stays_at_one(self):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X", char_limit=280))
        registry.register(_make_adapter("X", char_limit=500))
        assert len(registry) == 1


class TestRegisterDuplicateSkip:
    def test_skip_mode_does_not_raise(self):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X", char_limit=280))
        registry.register(_make_adapter("X", char_limit=500))  # no exception

    def test_skip_mode_keeps_existing_adapter(self):
        registry = AdapterRegistry(on_duplicate="skip")
        original = _make_adapter("X", char_limit=280)
        registry.register(original)
        registry.register(_make_adapter("X", char_limit=500))
        assert registry.get("x") is original

    def test_skip_mode_produces_no_log(self, caplog):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X", char_limit=280))
        with caplog.at_level(logging.DEBUG, logger="talos_agent.adapters.registry"):
            registry.register(_make_adapter("X", char_limit=500))
        assert len(caplog.records) == 0

    def test_skip_mode_count_stays_at_one(self):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X", char_limit=280))
        registry.register(_make_adapter("X", char_limit=500))
        assert len(registry) == 1


# ── replace() ────────────────────────────────────────────────────────────────


class TestReplace:
    def test_replace_swaps_adapter(self):
        registry = AdapterRegistry()
        old = _make_adapter("X")
        new = _make_adapter("X")
        registry.register(old)
        registry.replace(new)
        assert registry.get("x") is new

    def test_replace_returns_previous_adapter(self):
        registry = AdapterRegistry()
        old = _make_adapter("X")
        new = _make_adapter("X")
        registry.register(old)
        returned = registry.replace(new)
        assert returned is old

    def test_replace_on_empty_slot_returns_none(self):
        registry = AdapterRegistry()
        adapter = _make_adapter("X")
        returned = registry.replace(adapter)
        assert returned is None

    def test_replace_installs_adapter_when_slot_was_empty(self):
        registry = AdapterRegistry()
        adapter = _make_adapter("X")
        registry.replace(adapter)
        assert registry.get("x") is adapter
        assert len(registry) == 1

    def test_replace_does_not_raise_on_existing_entry(self):
        """replace() must never raise, regardless of on_duplicate setting."""
        registry = AdapterRegistry(on_duplicate="raise")
        registry.register(_make_adapter("X"))
        # Should not raise even though on_duplicate="raise"
        registry.replace(_make_adapter("X"))

    def test_replace_is_case_insensitive(self):
        registry = AdapterRegistry()
        old = _make_adapter("Telegram")
        new = _make_adapter("telegram")  # lower-case variant
        registry.register(old)
        prev = registry.replace(new)
        assert prev is old
        assert registry.get("telegram") is new

    def test_replace_multiple_times(self):
        registry = AdapterRegistry()
        adapters = [_make_adapter("X") for _ in range(4)]
        registry.replace(adapters[0])
        registry.replace(adapters[1])
        returned = registry.replace(adapters[2])
        assert returned is adapters[1]
        assert registry.get("x") is adapters[2]
        assert len(registry) == 1


# ── on_duplicate validation ──────────────────────────────────────────────────


class TestOnDuplicateValidation:
    def test_invalid_on_duplicate_raises_value_error(self):
        with pytest.raises(ValueError, match="on_duplicate"):
            AdapterRegistry(on_duplicate="overwrite")

    def test_valid_values_do_not_raise(self):
        for mode in ("raise", "warn", "skip"):
            AdapterRegistry(on_duplicate=mode)  # must not raise


# ── available_channels() and capabilities() ─────────────────────────────────


class TestIntrospection:
    def test_available_channels_reflects_registered_adapters(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("X"))
        registry.register(_make_adapter("Telegram"))
        channels = registry.available_channels()
        assert set(channels) == {"X", "Telegram"}

    def test_available_channels_after_replace(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("X"))
        new = _make_adapter("X")
        registry.replace(new)
        assert registry.available_channels() == ["X"]

    def test_capabilities_keys_match_channel_names(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("Discord"))
        caps = registry.capabilities()
        assert "Discord" in caps
