"""Unit tests for internal tools — local DB queries for agent context."""

from __future__ import annotations

import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

from talos_agent.config import Settings
from talos_agent.db import LocalDB


@pytest.fixture
def in_memory_db() -> LocalDB:
    db = LocalDB(path=Path(":memory:"))
    yield db
    db.close()


@pytest.fixture
def mock_internal_env(in_memory_db: LocalDB, mock_settings: Settings):
    """Set up internal tool environment with mocked DB."""
    return {
        "db": in_memory_db,
        "settings": mock_settings,
    }


class TestGetContentHistory:
    """Test get_content_history tool."""

    @pytest.mark.asyncio
    async def test_get_content_history_empty(self, mock_internal_env: dict):
        """get_content_history returns empty list when no content exists."""
        mock_internal_env["db"].get_recent_content = MagicMock(return_value=[])

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_content_history

            result = await get_content_history(limit=10)

            assert result == {"history": []}
            mock_internal_env["db"].get_recent_content.assert_called_once_with(10)

    @pytest.mark.asyncio
    async def test_get_content_history_with_data(self, mock_internal_env: dict):
        """get_content_history returns recent content rows."""
        mock_content = [
            {"id": 1, "content": "Hello world", "channel": "X"},
            {"id": 2, "content": "Second post", "channel": "X"},
        ]
        mock_internal_env["db"].get_recent_content = MagicMock(return_value=mock_content)

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_content_history

            result = await get_content_history(limit=5)

            assert result == {"history": mock_content}
            mock_internal_env["db"].get_recent_content.assert_called_once_with(5)

    @pytest.mark.asyncio
    async def test_get_content_history_default_limit(self, mock_internal_env: dict):
        """get_content_history uses default limit of 10."""
        mock_internal_env["db"].get_recent_content = MagicMock(return_value=[])

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_content_history

            result = await get_content_history()

            assert result == {"history": []}
            mock_internal_env["db"].get_recent_content.assert_called_once_with(10)


class TestGetScheduleStatus:
    """Test get_schedule_status tool."""

    @pytest.mark.asyncio
    async def test_get_schedule_status_empty(self, mock_internal_env: dict):
        """get_schedule_status returns zeros when no activity exists."""
        mock_internal_env["db"].count_today = MagicMock(return_value=0)
        mock_internal_env["db"].get_last_run = MagicMock(return_value=None)

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_schedule_status

            result = await get_schedule_status()

            assert result == {
                "posts_today": 0,
                "research_today": 0,
                "replies_today": 0,
                "last_agent_cycle": "never",
            }

    @pytest.mark.asyncio
    async def test_get_schedule_status_with_counts(self, mock_internal_env: dict):
        """get_schedule_status returns actual activity counts."""
        mock_internal_env["db"].count_today = MagicMock(side_effect=lambda x: {
            "post": 5,
            "research": 3,
            "reply": 2,
        }.get(x, 0))
        mock_internal_env["db"].get_last_run = MagicMock(
            return_value="2024-01-15T10:30:00Z"
        )

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_schedule_status

            result = await get_schedule_status()

            assert result == {
                "posts_today": 5,
                "research_today": 3,
                "replies_today": 2,
                "last_agent_cycle": "2024-01-15T10:30:00Z",
            }


class TestSaveResearchNotes:
    """Test save_research_notes tool."""

    @pytest.mark.asyncio
    async def test_save_research_notes_success(self, mock_internal_env: dict):
        """save_research_notes saves notes to DB."""
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import save_research_notes

            result = await save_research_notes(
                notes="AI trends show growth", channel="research"
            )

            assert result == {"status": "saved"}
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "research", "AI trends show growth", "research"
            )

    @pytest.mark.asyncio
    async def test_save_research_notes_default_channel(self, mock_internal_env: dict):
        """save_research_notes uses default channel 'research'."""
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import save_research_notes

            result = await save_research_notes(notes="Market analysis")

            assert result == {"status": "saved"}
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "research", "Market analysis", "research"
            )

    @pytest.mark.asyncio
    async def test_save_research_notes_custom_channel(self, mock_internal_env: dict):
        """save_research_notes accepts custom channel."""
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import save_research_notes

            result = await save_research_notes(
                notes="Competitor analysis", channel="competitive_intel"
            )

            assert result == {"status": "saved"}
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "research", "Competitor analysis", "competitive_intel"
            )


class TestGetActivePlaybook:
    """Test get_active_playbook tool."""

    @pytest.mark.asyncio
    async def test_get_active_playbook_exists(self, mock_internal_env: dict):
        """get_active_playbook returns active playbook when one exists."""
        mock_playbook = {
            "name": "Growth Engine",
            "data": {"cadence": "daily", "channels": ["X", "Telegram"]},
        }
        mock_internal_env["db"].get_active_playbook = MagicMock(return_value=mock_playbook)

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_active_playbook

            result = await get_active_playbook()

            assert result == mock_playbook
            mock_internal_env["db"].get_active_playbook.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_active_playbook_none(self, mock_internal_env: dict):
        """get_active_playbook returns status when no playbook exists."""
        mock_internal_env["db"].get_active_playbook = MagicMock(return_value=None)

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import get_active_playbook

            result = await get_active_playbook()

            assert result == {"status": "no_active_playbook"}
            mock_internal_env["db"].get_active_playbook.assert_called_once()


class TestRecordPost:
    """Test record_post tool."""

    @pytest.mark.asyncio
    async def test_record_post_success(self, mock_internal_env: dict):
        """record_post saves content and activity to DB."""
        mock_internal_env["db"].add_content = MagicMock()
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import record_post

            result = await record_post(
                content="Hello Stellar community!", channel="X"
            )

            assert result == {"status": "recorded"}
            mock_internal_env["db"].add_content.assert_called_once_with(
                "Hello Stellar community!", "X"
            )
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "post", "Hello Stellar community!", "X"
            )

    @pytest.mark.asyncio
    async def test_record_post_empty_content(self, mock_internal_env: dict):
        """record_post handles empty content."""
        mock_internal_env["db"].add_content = MagicMock()
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import record_post

            result = await record_post(content="", channel="X")

            assert result == {"status": "recorded"}
            mock_internal_env["db"].add_content.assert_called_once_with("", "X")
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "post", "", "X"
            )

    @pytest.mark.asyncio
    async def test_record_post_different_channels(self, mock_internal_env: dict):
        """record_post works with different channel names."""
        mock_internal_env["db"].add_content = MagicMock()
        mock_internal_env["db"].add_activity = MagicMock()

        with patch("talos_agent.tools.internal._db", mock_internal_env["db"]):
            from talos_agent.tools.internal import record_post

            result = await record_post(
                content="Telegram post", channel="Telegram"
            )

            assert result == {"status": "recorded"}
            mock_internal_env["db"].add_content.assert_called_once_with(
                "Telegram post", "Telegram"
            )
            mock_internal_env["db"].add_activity.assert_called_once_with(
                "post", "Telegram post", "Telegram"
            )
