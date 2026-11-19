"""Tests for AdapterRegistry duplicate-registration guard and replace() method.

Covers:
- Happy path: registering a single adapter succeeds.
- Duplicate registration raises ValueError (default on_duplicate="raise").
- Duplicate registration logs a warning and keeps the existing adapter
  (on_duplicate="warn").
- Duplicate registration is silently skipped (on_duplicate="skip").
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

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities, PublishResult
from talos_agent.adapters.registry import AdapterRegistry


# ── Minimal stub adapter ─────────────────────────────────────────────────────


def _make_adapter(channel_name: str) -> BaseSocialAdapter:
    """Create a lightweight mock that satisfies the BaseSocialAdapter interface."""
    adapter = MagicMock(spec=BaseSocialAdapter)
    adapter.channel_name = channel_name
    caps = ChannelCapabilities(char_limit=None)
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


class TestRegisterDuplicateRaise:
    """Default on_duplicate="raise" behaviour."""

    def test_duplicate_raises_value_error(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("X"))
        with pytest.raises(ValueError, match="Duplicate adapter registration"):
            registry.register(_make_adapter("X"))

    def test_error_message_contains_channel_name(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("Telegram"))
        with pytest.raises(ValueError, match="telegram"):
            registry.register(_make_adapter("Telegram"))

    def test_error_message_mentions_replace(self):
        registry = AdapterRegistry()
        registry.register(_make_adapter("Discord"))
        with pytest.raises(ValueError, match="replace"):
            registry.register(_make_adapter("Discord"))

    def test_first_adapter_is_unchanged_after_failed_register(self):
        """The existing adapter must not be touched on failure."""
        registry = AdapterRegistry()
        original = _make_adapter("X")
        registry.register(original)
        with pytest.raises(ValueError):
            registry.register(_make_adapter("X"))
        assert registry.get("x") is original

    def test_case_insensitive_duplicate_raises(self):
        """'X' and 'x' share the same key and must trigger the guard."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X"))
        with pytest.raises(ValueError, match="Duplicate"):
            registry.register(_make_adapter("x"))


class TestRegisterDuplicateWarn:
    def test_warn_mode_does_not_raise(self):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X"))
        # Must not raise
        registry.register(_make_adapter("X"))

    def test_warn_mode_keeps_existing_adapter(self):
        registry = AdapterRegistry(on_duplicate="warn")
        original = _make_adapter("X")
        registry.register(original)
        registry.register(_make_adapter("X"))
        assert registry.get("x") is original

    def test_warn_mode_emits_log_warning(self, caplog):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X"))
        with caplog.at_level(logging.WARNING, logger="talos_agent.adapters.registry"):
            registry.register(_make_adapter("X"))
        assert any("Duplicate" in r.message for r in caplog.records)

    def test_warn_mode_count_stays_at_one(self):
        registry = AdapterRegistry(on_duplicate="warn")
        registry.register(_make_adapter("X"))
        registry.register(_make_adapter("X"))
        assert len(registry) == 1


class TestRegisterDuplicateSkip:
    def test_skip_mode_does_not_raise(self):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X"))
        registry.register(_make_adapter("X"))  # no exception

    def test_skip_mode_keeps_existing_adapter(self):
        registry = AdapterRegistry(on_duplicate="skip")
        original = _make_adapter("X")
        registry.register(original)
        registry.register(_make_adapter("X"))
        assert registry.get("x") is original

    def test_skip_mode_produces_no_log(self, caplog):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X"))
        with caplog.at_level(logging.DEBUG, logger="talos_agent.adapters.registry"):
            registry.register(_make_adapter("X"))
        assert len(caplog.records) == 0

    def test_skip_mode_count_stays_at_one(self):
        registry = AdapterRegistry(on_duplicate="skip")
        registry.register(_make_adapter("X"))
        registry.register(_make_adapter("X"))
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
