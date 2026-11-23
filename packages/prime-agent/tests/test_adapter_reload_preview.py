"""Tests for adapter configuration reload preview (#1465).

Covers:
- Capability diff computation (added, removed, modified, unchanged channels).
- Affected scheduled tasks mapping (agent_cycle, learning_cycle, telemetry_log, telegram_queue).
- Candidate validation without external credentials or network access.
- Error handling for invalid candidates (None, invalid types, duplicate channels, malformed keys).
- Boundary cases: empty candidate, identical configuration, multiple channel alterations.
- Diagnostic fields integration for reload preview results.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from talos_agent.adapters.base import BaseSocialAdapter, ChannelCapabilities
from talos_agent.adapters.diagnostics import safe_adapter_diagnostic_fields
from talos_agent.adapters.registry import (
    AdapterRegistry,
    AdapterReloadPreview,
    CapabilityChange,
)


def _make_adapter(channel_name: str, **caps_kwargs) -> BaseSocialAdapter:
    """Create a lightweight mock satisfying BaseSocialAdapter."""
    adapter = MagicMock(spec=BaseSocialAdapter)
    adapter.channel_name = channel_name
    caps = ChannelCapabilities(
        char_limit=caps_kwargs.get("char_limit", None),
        supports_media=caps_kwargs.get("supports_media", False),
        supports_threads=caps_kwargs.get("supports_threads", False),
        supports_replies=caps_kwargs.get("supports_replies", True),
        supports_search=caps_kwargs.get("supports_search", False),
        supports_mentions=caps_kwargs.get("supports_mentions", False),
        supports_analytics=caps_kwargs.get("supports_analytics", False),
    )
    adapter.get_capabilities.return_value = caps
    return adapter


class TestAdapterReloadPreviewCapabilities:
    """Test capability diffs and channel changes in preview_reload."""

    def test_identical_candidate_has_no_changes(self) -> None:
        """When candidate has identical adapters and capabilities, has_changes is False."""
        registry = AdapterRegistry()
        x_adapter = _make_adapter("X", char_limit=280)
        registry.register(x_adapter)

        preview = registry.preview_reload([x_adapter])

        assert preview.valid is True
        assert preview.has_changes is False
        assert preview.added_channels == []
        assert preview.removed_channels == []
        assert preview.modified_channels == []
        assert preview.unchanged_channels == ["X"]
        assert preview.capability_diff == {}
        assert preview.affected_scheduled_tasks == []
        assert preview.validation_errors == []

    def test_added_channel_diff_and_affected_tasks(self) -> None:
        """Adding a channel lists it in added_channels and affects scheduler tasks."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))

        candidate_registry = AdapterRegistry()
        candidate_registry.register(_make_adapter("X", char_limit=280))
        candidate_registry.register(_make_adapter("Discord", char_limit=2000, supports_media=True))

        preview = registry.preview_reload(candidate_registry)

        assert preview.valid is True
        assert preview.has_changes is True
        assert preview.added_channels == ["Discord"]
        assert preview.removed_channels == []
        assert preview.modified_channels == []
        assert preview.unchanged_channels == ["X"]
        assert "Discord" in preview.capability_diff
        discord_diff = preview.capability_diff["Discord"]
        assert discord_diff.before == {}
        assert discord_diff.after["char_limit"] == 2000
        assert discord_diff.after["supports_media"] is True

        assert "agent_cycle" in preview.affected_scheduled_tasks
        assert "learning_cycle" in preview.affected_scheduled_tasks
        assert "telemetry_log" in preview.affected_scheduled_tasks
        # Discord addition does not trigger telegram_queue
        assert "telegram_queue" not in preview.affected_scheduled_tasks

    def test_removed_channel_diff(self) -> None:
        """Removing a channel identifies it in removed_channels."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        registry.register(_make_adapter("Mastodon", char_limit=500))

        candidate = [_make_adapter("X", char_limit=280)]
        preview = registry.preview_reload(candidate)

        assert preview.valid is True
        assert preview.has_changes is True
        assert preview.added_channels == []
        assert preview.removed_channels == ["Mastodon"]
        assert preview.modified_channels == []
        assert preview.unchanged_channels == ["X"]
        assert "Mastodon" in preview.capability_diff
        assert preview.capability_diff["Mastodon"].after == {}
        assert preview.capability_diff["Mastodon"].before["char_limit"] == 500

    def test_modified_channel_capabilities(self) -> None:
        """Modifying capabilities updates modified_channels and details diffs."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280, supports_media=False))

        candidate_x = _make_adapter("X", char_limit=25000, supports_media=True)
        preview = registry.preview_reload([candidate_x])

        assert preview.valid is True
        assert preview.has_changes is True
        assert preview.added_channels == []
        assert preview.removed_channels == []
        assert preview.modified_channels == ["X"]
        assert preview.unchanged_channels == []
        assert "X" in preview.capability_diff
        x_diff = preview.capability_diff["X"]
        assert x_diff.differences["char_limit"] == {"before": 280, "after": 25000}
        assert x_diff.differences["supports_media"] == {"before": False, "after": True}

    def test_telegram_channel_change_affects_telegram_queue(self) -> None:
        """Adding, removing, or modifying Telegram adapter triggers telegram_queue task."""
        # 1. Adding Telegram
        registry1 = AdapterRegistry()
        registry1.register(_make_adapter("X", char_limit=280))
        cand1 = [_make_adapter("X", char_limit=280), _make_adapter("Telegram", char_limit=4096)]
        preview1 = registry1.preview_reload(cand1)
        assert "telegram_queue" in preview1.affected_scheduled_tasks

        # 2. Modifying Telegram
        registry2 = AdapterRegistry()
        registry2.register(_make_adapter("Telegram", char_limit=4096, supports_threads=False))
        cand2 = [_make_adapter("Telegram", char_limit=4096, supports_threads=True)]
        preview2 = registry2.preview_reload(cand2)
        assert "telegram_queue" in preview2.affected_scheduled_tasks

        # 3. Removing Telegram
        registry3 = AdapterRegistry()
        registry3.register(_make_adapter("Telegram", char_limit=4096))
        preview3 = registry3.preview_reload([])
        assert "telegram_queue" in preview3.affected_scheduled_tasks


class TestAdapterReloadCandidateValidation:
    """Validate candidate without using external credentials or networks."""

    def test_none_candidate_is_invalid(self) -> None:
        registry = AdapterRegistry()
        preview = registry.preview_reload(None)
        assert preview.valid is False
        assert preview.has_changes is False
        assert any("None" in err for err in preview.validation_errors)

    def test_invalid_type_candidate(self) -> None:
        registry = AdapterRegistry()
        preview = registry.preview_reload(12345)
        assert preview.valid is False
        assert any("Unsupported candidate type" in err for err in preview.validation_errors)

    def test_candidate_list_with_invalid_element(self) -> None:
        registry = AdapterRegistry()
        preview = registry.preview_reload(["not_an_adapter", 42])
        assert preview.valid is False
        assert len(preview.validation_errors) >= 2

    def test_candidate_duplicate_channel_in_list(self) -> None:
        registry = AdapterRegistry()
        adapter1 = _make_adapter("X")
        adapter2 = _make_adapter("x")  # duplicate case-insensitively
        preview = registry.preview_reload([adapter1, adapter2])
        assert preview.valid is False
        assert any("Duplicate channel" in err for err in preview.validation_errors)

    def test_candidate_dictionary_of_capabilities(self) -> None:
        """Accepts a mapping of channel name -> ChannelCapabilities or dict."""
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))

        candidate = {
            "X": ChannelCapabilities(char_limit=280),
            "Mastodon": {"char_limit": 500, "supports_media": True},
        }
        preview = registry.preview_reload(candidate)
        assert preview.valid is True
        assert preview.has_changes is True
        assert preview.added_channels == ["Mastodon"]
        assert preview.unchanged_channels == ["X"]

    def test_candidate_dictionary_invalid_keys(self) -> None:
        registry = AdapterRegistry()
        candidate = {
            "": ChannelCapabilities(char_limit=280),
            None: ChannelCapabilities(char_limit=500),  # type: ignore[dict-item]
        }
        preview = registry.preview_reload(candidate)
        assert preview.valid is False
        assert len(preview.validation_errors) >= 2


class TestAdapterReloadDiagnosticsIntegration:
    """Verify serialization and diagnostic field safety for reload preview."""

    def test_preview_to_dict_structure(self) -> None:
        registry = AdapterRegistry()
        registry.register(_make_adapter("X", char_limit=280))
        preview = registry.preview_reload([
            _make_adapter("X", char_limit=500),
            _make_adapter("Discord", char_limit=2000),
        ])

        data = preview.to_dict()
        assert isinstance(preview, AdapterReloadPreview)
        assert isinstance(preview.capability_diff["X"], CapabilityChange)
        assert data["valid"] is True
        assert data["has_changes"] is True
        assert data["added_channels"] == ["Discord"]
        assert data["modified_channels"] == ["X"]
        assert data["removed_channels"] == []
        assert data["unchanged_channels"] == []
        assert "Discord" in data["capability_diff"]
        assert "X" in data["capability_diff"]
        assert data["capability_diff"]["X"]["differences"]["char_limit"] == {
            "before": 280,
            "after": 500,
        }

    def test_safe_adapter_diagnostic_fields_with_reload_preview(self) -> None:
        """Preview summary fields integrate with safe_adapter_diagnostic_fields."""
        fields = safe_adapter_diagnostic_fields(
            operation="reload_preview",
            valid=True,
            has_changes=True,
            added_channels=["Discord", "Mastodon"],
            removed_channels=["X"],
            affected_scheduled_tasks=["agent_cycle", "telemetry_log"],
            outcome="succeeded",
        )
        assert fields["operation"] == "reload_preview"
        assert fields["valid"] is True
        assert fields["has_changes"] is True
        assert fields["added_channels"] == ["Discord", "Mastodon"]
        assert fields["removed_channels"] == ["X"]
        assert fields["affected_scheduled_tasks"] == ["agent_cycle", "telemetry_log"]
        assert fields["outcome"] == "succeeded"
