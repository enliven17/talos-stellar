"""Unit tests for web_api tools — reporting and approval interactions."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

from talos_agent.config import Settings
from talos_agent.api_client import TalosAPIClient


@pytest.fixture
def mock_web_api_env(mock_settings: Settings):
    """Set up web_api tool environment with mocked API and settings."""
    mock_api = AsyncMock(spec=TalosAPIClient)
    return {
        "api": mock_api,
        "settings": mock_settings,
    }


class TestReportActivity:
    """Test report_activity tool."""

    @pytest.mark.asyncio
    async def test_report_activity_success(self, mock_web_api_env: dict):
        """report_activity returns API response on success."""
        mock_web_api_env["api"].report_activity = AsyncMock(
            return_value={"id": "activity-123", "status": "recorded"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_activity

            result = await report_activity(
                type="post", content="Hello world", channel="X"
            )

            assert result == {"id": "activity-123", "status": "recorded"}
            mock_web_api_env["api"].report_activity.assert_called_once_with(
                mock_web_api_env["settings"].talos_id,
                type_="post",
                content="Hello world",
                channel="X",
            )

    @pytest.mark.asyncio
    async def test_report_activity_api_failure(self, mock_web_api_env: dict):
        """report_activity returns default status when API returns None."""
        mock_web_api_env["api"].report_activity = AsyncMock(return_value=None)

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_activity

            result = await report_activity(
                type="research", content="Analysis notes", channel="research"
            )

            assert result == {"status": "reported"}
            mock_web_api_env["api"].report_activity.assert_called_once()

    @pytest.mark.asyncio
    async def test_report_activity_empty_content(self, mock_web_api_env: dict):
        """report_activity handles empty content."""
        mock_web_api_env["api"].report_activity = AsyncMock(
            return_value={"id": "activity-456"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_activity

            result = await report_activity(type="post", content="", channel="X")

            assert result == {"id": "activity-456"}
            mock_web_api_env["api"].report_activity.assert_called_once_with(
                mock_web_api_env["settings"].talos_id,
                type_="post",
                content="",
                channel="X",
            )


class TestRequestApproval:
    """Test request_approval tool."""

    @pytest.mark.asyncio
    async def test_request_approval_success(self, mock_web_api_env: dict):
        """request_approval returns approval ID on success."""
        mock_web_api_env["api"].create_approval = AsyncMock(
            return_value={"id": "approval-123", "status": "pending"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="transaction",
                title="High-value purchase",
                description="Purchase premium service",
                amount=100.0,
            )

            assert result == {
                "status": "approval_requested",
                "approval_id": "approval-123",
            }
            mock_web_api_env["api"].create_approval.assert_called_once_with(
                mock_web_api_env["settings"].talos_id,
                type_="transaction",
                title="High-value purchase",
                description="Purchase premium service",
                amount=100.0,
            )

    @pytest.mark.asyncio
    async def test_request_approval_api_failure(self, mock_web_api_env: dict):
        """request_approval returns error when API returns None."""
        mock_web_api_env["api"].create_approval = AsyncMock(return_value=None)

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="strategy_change",
                title="Update GTM strategy",
            )

            assert result == {"error": "Failed to create approval request"}
            mock_web_api_env["api"].create_approval.assert_called_once()

    @pytest.mark.asyncio
    async def test_request_approval_with_defaults(self, mock_web_api_env: dict):
        """request_approval handles optional parameters with defaults."""
        mock_web_api_env["api"].create_approval = AsyncMock(
            return_value={"id": "approval-456"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="transaction", title="Simple transaction"
            )

            assert result == {
                "status": "approval_requested",
                "approval_id": "approval-456",
            }
            # Verify None is passed for optional params
            call_args = mock_web_api_env["api"].create_approval.call_args
            assert call_args[1]["description"] is None
            assert call_args[1]["amount"] is None

    @pytest.mark.asyncio
    async def test_request_approval_empty_description(self, mock_web_api_env: dict):
        """request_approval converts empty description to None."""
        mock_web_api_env["api"].create_approval = AsyncMock(
            return_value={"id": "approval-789"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="transaction", title="Test", description=""
            )

            assert result == {
                "status": "approval_requested",
                "approval_id": "approval-789",
            }
            call_args = mock_web_api_env["api"].create_approval.call_args
            assert call_args[1]["description"] is None

    @pytest.mark.asyncio
    async def test_request_approval_zero_amount(self, mock_web_api_env: dict):
        """request_approval converts zero amount to None."""
        mock_web_api_env["api"].create_approval = AsyncMock(
            return_value={"id": "approval-999"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="transaction", title="Test", amount=0.0
            )

            assert result == {
                "status": "approval_requested",
                "approval_id": "approval-999",
            }
            call_args = mock_web_api_env["api"].create_approval.call_args
            assert call_args[1]["amount"] is None


class TestCheckApproval:
    """Test check_approval tool."""

    @pytest.mark.asyncio
    async def test_check_approval_pending(self, mock_web_api_env: dict):
        """check_approval returns pending status."""
        mock_web_api_env["api"].get_approval = AsyncMock(
            return_value={"id": "approval-123", "status": "pending"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("approval-123")

            assert result == {"status": "pending", "decided_by": None}
            mock_web_api_env["api"].get_approval.assert_called_once_with(
                mock_web_api_env["settings"].talos_id, "approval-123"
            )

    @pytest.mark.asyncio
    async def test_check_approval_approved(self, mock_web_api_env: dict):
        """check_approval returns approved status with decider."""
        mock_web_api_env["api"].get_approval = AsyncMock(
            return_value={
                "id": "approval-123",
                "status": "approved",
                "decidedBy": "patron@example.com",
            }
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("approval-123")

            assert result == {"status": "approved", "decided_by": "patron@example.com"}
            mock_web_api_env["api"].get_approval.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_approval_rejected(self, mock_web_api_env: dict):
        """check_approval returns rejected status."""
        mock_web_api_env["api"].get_approval = AsyncMock(
            return_value={
                "id": "approval-123",
                "status": "rejected",
                "decidedBy": "patron@example.com",
            }
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("approval-123")

            assert result == {"status": "rejected", "decided_by": "patron@example.com"}
            mock_web_api_env["api"].get_approval.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_approval_not_found(self, mock_web_api_env: dict):
        """check_approval returns error when approval not found."""
        mock_web_api_env["api"].get_approval = AsyncMock(return_value=None)

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("nonexistent-approval")

            assert result == {"error": "Approval not found"}
            mock_web_api_env["api"].get_approval.assert_called_once()


class TestReportRevenue:
    """Test report_revenue tool."""

    @pytest.mark.asyncio
    async def test_report_revenue_success(self, mock_web_api_env: dict):
        """report_revenue returns API response on success."""
        mock_web_api_env["api"].report_revenue = AsyncMock(
            return_value={"id": "revenue-123", "amount": 50.0, "source": "playbook_sale"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(
                amount=50.0, source="playbook_sale", tx_hash="tx-2024-001"
            )

            assert result == {
                "id": "revenue-123",
                "amount": 50.0,
                "source": "playbook_sale",
            }
            mock_web_api_env["api"].report_revenue.assert_called_once_with(
                mock_web_api_env["settings"].talos_id,
                amount=50.0,
                source="playbook_sale",
                tx_hash="tx-2024-001",
            )

    @pytest.mark.asyncio
    async def test_report_revenue_api_failure(self, mock_web_api_env: dict):
        """report_revenue returns default status when API returns None."""
        mock_web_api_env["api"].report_revenue = AsyncMock(return_value=None)

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(
                amount=25.0, source="service_fee", tx_hash="tx-456"
            )

            assert result == {"status": "reported"}
            mock_web_api_env["api"].report_revenue.assert_called_once()

    @pytest.mark.asyncio
    async def test_report_revenue_without_tx_hash(self, mock_web_api_env: dict):
        """report_revenue handles missing tx_hash."""
        mock_web_api_env["api"].report_revenue = AsyncMock(
            return_value={"id": "revenue-456"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(amount=100.0, source="consulting")

            assert result == {"id": "revenue-456"}
            call_args = mock_web_api_env["api"].report_revenue.call_args
            assert call_args[1]["tx_hash"] is None

    @pytest.mark.asyncio
    async def test_report_revenue_empty_tx_hash(self, mock_web_api_env: dict):
        """report_revenue converts empty tx_hash to None."""
        mock_web_api_env["api"].report_revenue = AsyncMock(
            return_value={"id": "revenue-789"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(
                amount=75.0, source="playbook_sale", tx_hash=""
            )

            assert result == {"id": "revenue-789"}
            call_args = mock_web_api_env["api"].report_revenue.call_args
            assert call_args[1]["tx_hash"] is None

    @pytest.mark.asyncio
    async def test_report_revenue_zero_amount(self, mock_web_api_env: dict):
        """report_revenue handles zero amount."""
        mock_web_api_env["api"].report_revenue = AsyncMock(
            return_value={"id": "revenue-999"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_web_api_env["api"]
        ), patch("talos_agent.tools.web_api._settings", mock_web_api_env["settings"]):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(amount=0.0, source="test")

            assert result == {"id": "revenue-999"}
            mock_web_api_env["api"].report_revenue.assert_called_once_with(
                mock_web_api_env["settings"].talos_id,
                amount=0.0,
                source="test",
                tx_hash=None,
            )
