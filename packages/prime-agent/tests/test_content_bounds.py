"""Unit tests for content history limit clamping and research note truncation.

Covers Issue #974:
- get_content_history clamps LLM-provided limits to the configured maximum.
- save_research_notes truncates large notes and records truncation metadata.
- AgentContext.from_db applies the same cap where content history is rendered.
"""

from __future__ import annotations

import pytest

from talos_agent.agent.context import (
    DEFAULT_CONTEXT_CONTENT_LIMIT,
    MAX_CONTEXT_CONTENT_LIMIT,
    AgentContext,
)
from talos_agent.db import LocalDB
from talos_agent.tools import internal

# ── Helpers ──────────────────────────────────────────────────────────────────


class FakeSettings:
    """Minimal settings double exposing the two new fields."""

    def __init__(
        self,
        content_history_max_limit: int = 50,
        research_notes_max_bytes: int = 4096,
    ) -> None:
        self.content_history_max_limit = content_history_max_limit
        self.research_notes_max_bytes = research_notes_max_bytes


@pytest.fixture
def db_with_content(mock_db: LocalDB) -> LocalDB:
    """Seed a LocalDB with 60 content history rows."""
    for i in range(60):
        mock_db.add_content(f"post number {i}", "X")
    return mock_db


def _patch_internal(db: LocalDB, settings: FakeSettings | None = None):
    """Patch the module-level _db and _settings on internal tools."""
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        old_db = internal._db
        old_settings = internal._settings
        internal._db = db
        internal._settings = settings
        try:
            yield
        finally:
            internal._db = old_db
            internal._settings = old_settings

    return _ctx()


# ══════════════════════════════════════════════════════════════════════════════
# get_content_history — limit clamping
# ══════════════════════════════════════════════════════════════════════════════


class TestGetContentHistoryClamping:
    @pytest.mark.asyncio
    async def test_default_limit_is_respected(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=10)
        assert len(result["history"]) == 10
        assert result["limit_requested"] == 10
        assert result["limit_applied"] == 10
        assert result["limit_clamped"] is False
        assert result["max_limit"] == 50

    @pytest.mark.asyncio
    async def test_limit_above_max_is_clamped(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=200)
        assert result["limit_requested"] == 200
        assert result["limit_applied"] == 50
        assert result["limit_clamped"] is True
        assert len(result["history"]) == 50

    @pytest.mark.asyncio
    async def test_limit_exactly_at_max_not_clamped(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=50)
        assert result["limit_requested"] == 50
        assert result["limit_applied"] == 50
        assert result["limit_clamped"] is False
        assert len(result["history"]) == 50

    @pytest.mark.asyncio
    async def test_limit_of_one_is_respected(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=1)
        assert result["limit_applied"] == 1
        assert len(result["history"]) == 1

    @pytest.mark.asyncio
    async def test_zero_or_negative_limit_clamped_to_one(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=0)
        assert result["limit_applied"] == 1
        assert result["limit_clamped"] is True

    @pytest.mark.asyncio
    async def test_non_integer_limit_falls_back_to_default(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=50)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit="not_a_number")  # type: ignore[arg-type]
        assert result["limit_applied"] == 10  # fallback default
        assert result["limit_clamped"] is True

    @pytest.mark.asyncio
    async def test_configurable_max_limit(self, db_with_content):
        settings = FakeSettings(content_history_max_limit=5)
        with _patch_internal(db_with_content, settings):
            result = await internal.get_content_history(limit=100)
        assert result["limit_applied"] == 5
        assert result["max_limit"] == 5
        assert len(result["history"]) == 5

    @pytest.mark.asyncio
    async def test_no_settings_uses_safe_default(self, db_with_content):
        with _patch_internal(db_with_content, None):
            result = await internal.get_content_history(limit=9999)
        # Default max is 50 when no settings are injected.
        assert result["limit_applied"] == 50
        assert result["limit_clamped"] is True


# ══════════════════════════════════════════════════════════════════════════════
# save_research_notes — truncation
# ══════════════════════════════════════════════════════════════════════════════


class TestSaveResearchNotesTruncation:
    @pytest.mark.asyncio
    async def test_short_notes_not_truncated(self, mock_db):
        settings = FakeSettings(research_notes_max_bytes=4096)
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes("short note")
        assert result["status"] == "saved"
        assert result["truncated"] is False

    @pytest.mark.asyncio
    async def test_long_notes_are_truncated(self, mock_db):
        settings = FakeSettings(research_notes_max_bytes=100)
        big = "x" * 500
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes(big)
        assert result["status"] == "saved"
        assert result["truncated"] is True
        assert result["original_bytes"] == 500
        assert result["stored_bytes"] <= 100
        assert result["max_bytes"] == 100

    @pytest.mark.asyncio
    async def test_truncation_marker_is_appended(self, mock_db):
        settings = FakeSettings(research_notes_max_bytes=50)
        big = "A" * 200
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes(big)
        # Read back what was stored.
        activities = mock_db.get_pending_activities(limit=1)
        stored = activities[0]["content"] if activities else ""
        assert "[truncated:" in stored
        assert result["truncated"] is True

    @pytest.mark.asyncio
    async def test_exact_boundary_not_truncated(self, mock_db):
        settings = FakeSettings(research_notes_max_bytes=64)
        notes = "B" * 64
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes(notes)
        assert result["truncated"] is False
        assert result["original_bytes"] == 64
        assert result["stored_bytes"] == 64

    @pytest.mark.asyncio
    async def test_unicode_truncates_at_utf8_boundary(self, mock_db):
        # Each emoji is 4 bytes in UTF-8.
        settings = FakeSettings(research_notes_max_bytes=10)
        notes = "🎉" * 10  # 40 bytes total
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes(notes)
        assert result["truncated"] is True
        assert result["stored_bytes"] <= 10

    @pytest.mark.asyncio
    async def test_empty_notes_not_truncated(self, mock_db):
        settings = FakeSettings(research_notes_max_bytes=4096)
        with _patch_internal(mock_db, settings):
            result = await internal.save_research_notes("")
        assert result["truncated"] is False
        assert result["original_bytes"] == 0

    @pytest.mark.asyncio
    async def test_no_settings_uses_safe_default(self, mock_db):
        big = "C" * 10000
        with _patch_internal(mock_db, None):
            result = await internal.save_research_notes(big)
        assert result["truncated"] is True
        assert result["max_bytes"] == 4096


# ══════════════════════════════════════════════════════════════════════════════
# AgentContext.from_db — content history cap
# ══════════════════════════════════════════════════════════════════════════════


class TestAgentContextContentCap:
    def test_default_content_limit(self, db_with_content):
        ctx = AgentContext.from_db(db_with_content, {})
        assert len(ctx.recent_content) == DEFAULT_CONTEXT_CONTENT_LIMIT

    def test_custom_content_limit_within_range(self, db_with_content):
        ctx = AgentContext.from_db(db_with_content, {}, content_history_limit=20)
        assert len(ctx.recent_content) == 20

    def test_content_limit_clamped_to_max(self, db_with_content):
        ctx = AgentContext.from_db(db_with_content, {}, content_history_limit=999)
        assert len(ctx.recent_content) == MAX_CONTEXT_CONTENT_LIMIT

    def test_content_limit_clamped_to_min(self, db_with_content):
        ctx = AgentContext.from_db(db_with_content, {}, content_history_limit=-5)
        assert len(ctx.recent_content) == 1

    def test_to_context_block_is_bounded(self, db_with_content):
        ctx = AgentContext.from_db(db_with_content, {}, content_history_limit=50)
        block = ctx.to_context_block()
        # Each content line is capped at 80 chars; with 50 rows the block
        # should stay well within a reasonable prompt budget.
        assert "Recent posts (avoid duplicates):" in block
        # Count content entries rendered.
        lines = [l for l in block.splitlines() if l.startswith("  - ")]
        assert len(lines) == 50
        # Verify each content snippet is ≤ 80 chars (plus prefix overhead).
        for line in lines:
            # The prefix "  - [channel] " is stripped; content is after that.
            content_part = line.split("] ", 1)[-1] if "] " in line else line
            assert len(content_part) <= 80


# ══════════════════════════════════════════════════════════════════════════════
# Helper function unit tests
# ══════════════════════════════════════════════════════════════════════════════


class TestClampLimit:
    def test_within_range(self):
        assert internal._clamp_limit(10, 50) == 10

    def test_above_max_clamped(self):
        assert internal._clamp_limit(100, 50) == 50

    def test_below_min_clamped(self):
        assert internal._clamp_limit(0, 50) == 1

    def test_negative_clamped(self):
        assert internal._clamp_limit(-10, 50) == 1

    def test_at_max(self):
        assert internal._clamp_limit(50, 50) == 50

    def test_invalid_type_falls_back(self):
        assert internal._clamp_limit("bad", 50) == 10  # type: ignore[arg-type]

    def test_none_falls_back(self):
        assert internal._clamp_limit(None, 50) == 10  # type: ignore[arg-type]


class TestTruncateNotes:
    def test_short_note_unchanged(self):
        assert internal._truncate_notes("hello", 100) == "hello"

    def test_long_note_truncated_with_marker(self):
        result = internal._truncate_notes("A" * 200, 50)
        assert "[truncated:" in result
        assert len(result.encode("utf-8")) <= 50

    def test_exact_boundary_unchanged(self):
        result = internal._truncate_notes("B" * 64, 64)
        assert "[truncated:" not in result
        assert result == "B" * 64

    def test_unicode_safe_truncation(self):
        result = internal._truncate_notes("🎉" * 20, 10)
        assert len(result.encode("utf-8")) <= 10
        # No partial codepoint should be present.
        result.encode("utf-8").decode("utf-8")  # should not raise

    def test_non_string_coerced(self):
        result = internal._truncate_notes(12345, 100)
        assert "12345" in result
