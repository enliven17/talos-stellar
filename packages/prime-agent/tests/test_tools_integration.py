"""Integration tests for agent tools (commerce, stellar, web_api)."""

from __future__ import annotations

import json
import pytest
import respx
from httpx import Response
from unittest.mock import AsyncMock, MagicMock, patch
from pathlib import Path

from talos_agent.config import Settings
from talos_agent.db import LocalDB
from talos_agent.api_client import TalosAPIClient
from talos_agent.payments.x402_signer import X402Signer
from talos_agent.payments.stellar_kit import StellarKit


# ══════════════════════════════════════════════════════════════════════════════
# Commerce Tool Tests
# ══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def mock_commerce_env(mock_settings: Settings, mock_db: LocalDB):
    """Set up commerce tool environment with mocked API and DB."""
    mock_api = AsyncMock(spec=TalosAPIClient)
    return {
        "api": mock_api,
        "db": mock_db,
        "settings": mock_settings,
    }


class TestCommerceDiscoverServices:
    """Test service discovery tool."""

    @pytest.mark.asyncio
    async def test_discover_services_returns_list(self, mock_commerce_env):
        """discover_services returns matching services with metadata."""
        mock_services = [
            {
                "id": "svc-1",
                "name": "Content Generation",
                "provider": "content-talos",
                "price": 5.0,
            },
            {
                "id": "svc-2",
                "name": "Data Analysis",
                "provider": "analytics-talos",
                "price": 15.0,
            },
        ]
        mock_commerce_env["api"].discover_services = AsyncMock(
            return_value=mock_services
        )

        # Inject mocks into commerce tool
        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]):
            from talos_agent.tools.commerce import discover_services

            result = await discover_services()

            assert result["count"] == 2
            assert len(result["services"]) == 2
            assert result["category_searched"] in ["Sales", "Marketing", "Analytics"]


class TestCommercePriceConversion:
    """Test price to USDC units conversion for x402 payments."""

    def test_price_to_usdc_units_standard_decimal(self):
        """price_to_usdc_units handles standard decimals."""
        from talos_agent.tools.commerce import price_to_usdc_units

        assert price_to_usdc_units("1.05") == 1_050_000

    def test_price_to_usdc_units_truncates_beyond_six_decimals(self):
        """price_to_usdc_units truncates values beyond 6 decimals."""
        from talos_agent.tools.commerce import price_to_usdc_units

        assert price_to_usdc_units("1.1234567") == 1_123_456

    def test_price_to_usdc_units_whole_number(self):
        """price_to_usdc_units handles whole numbers."""
        from talos_agent.tools.commerce import price_to_usdc_units

        assert price_to_usdc_units("10") == 10_000_000

    def test_price_to_usdc_units_smallest_unit(self):
        """price_to_usdc_units preserves smallest units."""
        from talos_agent.tools.commerce import price_to_usdc_units

        assert price_to_usdc_units("0.000001") == 1


class TestCommercePurchaseFlow:
    """Test end-to-end service purchase flow."""

    @pytest.mark.asyncio
    async def test_purchase_service_with_402_response(
        self, mock_commerce_env: dict
    ):
        """purchase_service handles 402 response and signs payment."""
        mock_commerce_env["api"].get_service = AsyncMock(
            return_value=Response(
                402,
                json={
                    "price": 10.0,
                    "payee": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
                    "token": "GBBD47UZQ5PBC4MUE4BBQWBW6IM5I46UYOWMUSFA67YPPY권",
                    "chainId": 280,
                },
            )
        )
        mock_commerce_env["api"].create_approval = AsyncMock(
            return_value=None  # Below threshold, no approval needed
        )
        mock_commerce_env["api"].submit_commerce = AsyncMock(
            return_value={"jobId": "job-001", "status": "submitted"}
        )

        # Mock signer
        mock_signer = AsyncMock(spec=X402Signer)
        mock_signer.initialize = AsyncMock()
        mock_signer.sign_payment = AsyncMock(
            return_value={
                "status": "signed",
                "payment_header": "Bearer eyJhbGc...",
            }
        )

        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]), patch(
            "talos_agent.tools.commerce._settings", mock_commerce_env["settings"]
        ), patch(
            "talos_agent.tools.commerce._get_signer", return_value=mock_signer
        ):
            from talos_agent.tools.commerce import purchase_service

            result = await purchase_service(
                talos_id="other-talos",
                service_type="playbook",
                payload='{"niche": "AI"}',
            )

            assert result["status"] == "submitted"
            assert result["job_id"] == "job-001"
            mock_signer.initialize.assert_called_once()
            mock_signer.sign_payment.assert_called_once()

    @pytest.mark.asyncio
    async def test_purchase_service_approval_required(self, mock_commerce_env: dict):
        """purchase_service requests approval for high-value transactions."""
        mock_commerce_env["api"].get_service = AsyncMock(
            return_value=Response(
                402,
                json={
                    "price": 50.0,  # Above typical threshold
                    "payee": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
                },
            )
        )
        mock_commerce_env["api"].create_approval = AsyncMock(
            return_value={"id": "approval-123"}
        )

        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]), patch(
            "talos_agent.tools.commerce._settings", mock_commerce_env["settings"]
        ):
            from talos_agent.tools.commerce import purchase_service

            result = await purchase_service("other-talos", "premium-service")

            assert result["status"] == "approval_requested"
            assert result["approval_id"] == "approval-123"

    @pytest.mark.asyncio
    async def test_purchase_service_budget_exceeded(self, mock_commerce_env: dict):
        """purchase_service rejects purchase if GTM budget exhausted."""
        # Set up DB to show high spending
        mock_commerce_env["db"].get_spending_period = MagicMock(
            return_value=200.0  # Already spent full budget
        )
        mock_commerce_env["db"].get_talos_config = MagicMock(
            return_value={"gtmBudget": 200}
        )
        mock_commerce_env["settings"].approval_threshold = 10.0

        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]), patch(
            "talos_agent.tools.commerce._settings", mock_commerce_env["settings"]
        ):
            from talos_agent.tools.commerce import purchase_service

            result = await purchase_service("other-talos")

            assert "error" in result
            assert "budget" in result["error"].lower()


class TestCommercePolling:
    """Test job result polling."""

    @pytest.mark.asyncio
    async def test_poll_service_result_pending(self, mock_commerce_env: dict):
        """poll_service_result returns pending status."""
        mock_commerce_env["api"].get_job_result = AsyncMock(return_value=None)

        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]):
            from talos_agent.tools.commerce import poll_service_result

            result = await poll_service_result("job-001")

            assert result["status"] == "pending"
            assert result["job_id"] == "job-001"

    @pytest.mark.asyncio
    async def test_poll_service_result_completed(self, mock_commerce_env: dict):
        """poll_service_result returns result when completed."""
        mock_commerce_env["api"].get_job_result = AsyncMock(
            return_value={
                "status": "completed",
                "result": {"playbook": "data"},
                "talosId": "provider-talos",
            }
        )
        mock_commerce_env["db"].update_commerce_status = MagicMock()

        with patch(
            "talos_agent.tools.commerce._api", mock_commerce_env["api"]
        ), patch("talos_agent.tools.commerce._db", mock_commerce_env["db"]):
            from talos_agent.tools.commerce import poll_service_result

            result = await poll_service_result("job-001")

            assert result["status"] == "completed"
            assert result["result"] == {"playbook": "data"}


# ══════════════════════════════════════════════════════════════════════════════
# Stellar Tool Tests
# ══════════════════════════════════════════════════════════════════════════════


class TestStellarTransferTool:
    """Test XLM transfer tool."""

    @pytest.mark.asyncio
    async def test_transfer_xlm_below_threshold(self, mock_settings: Settings):
        """transfer_xlm executes directly for small amounts."""
        mock_api = AsyncMock()
        mock_api.create_approval = AsyncMock()

        kit = AsyncMock(spec=StellarKit)
        kit.transfer_xlm = AsyncMock(
            return_value={
                "status": "submitted",
                "to": "GBUQWP3...",
                "amount": 10.0,
            }
        )

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings), patch(
            "talos_agent.tools.stellar._get_kit", return_value=kit
        ):
            from talos_agent.tools.stellar import transfer_xlm

            result = await transfer_xlm("GBUQWP3...", 10.0)

            assert result["status"] == "submitted"
            # Should not request approval for small amount
            mock_api.create_approval.assert_not_called()

    @pytest.mark.asyncio
    async def test_transfer_xlm_requires_approval(self, mock_settings: Settings):
        """transfer_xlm requests approval for large amounts."""
        mock_settings.approval_threshold = 50.0

        mock_api = AsyncMock()
        mock_api.create_approval = AsyncMock(
            return_value={"id": "approval-456"}
        )

        kit = AsyncMock(spec=StellarKit)

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings), patch(
            "talos_agent.tools.stellar._get_kit", return_value=kit
        ):
            from talos_agent.tools.stellar import transfer_xlm

            result = await transfer_xlm("GBUQWP3...", 100.0, reason="Dividend payout")

            assert result["status"] == "approval_requested"
            assert result["approval_id"] == "approval-456"
            mock_api.create_approval.assert_called_once()


class TestStellarBalanceQueries:
    """Test XLM balance query tool."""

    @pytest.mark.asyncio
    async def test_get_xlm_balance(self, mock_settings: Settings):
        """get_xlm_balance returns current balance."""
        mock_api = AsyncMock()

        kit = AsyncMock(spec=StellarKit)
        kit.initialize = AsyncMock()
        kit.get_balance = AsyncMock(
            return_value={
                "balance_xlm": 250.5,
                "account": "GBUQWP3...",
            }
        )

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings), patch(
            "talos_agent.tools.stellar._get_kit", return_value=kit
        ):
            from talos_agent.tools.stellar import get_xlm_balance

            result = await get_xlm_balance()

            assert result["balance_xlm"] == 250.5
            kit.initialize.assert_called_once()
            kit.get_balance.assert_called_once()


class TestStellarPulseTokens:
    """Test Pulse token operations."""

    @pytest.mark.asyncio
    async def test_create_pulse_token_requires_approval(self, mock_settings: Settings):
        """create_pulse_token always requires Creator approval."""
        mock_api = AsyncMock()
        mock_api.create_approval = AsyncMock(
            return_value={"id": "approval-789"}
        )

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings):
            from talos_agent.tools.stellar import create_pulse_token

            result = await create_pulse_token(
                name="Governance Token",
                symbol="GOVERN",
                initial_supply=1_000_000,
            )

            assert result["status"] == "approval_requested"
            assert result["name"] == "Governance Token"
            mock_api.create_approval.assert_called_once()

    @pytest.mark.asyncio
    async def test_airdrop_pulse_below_threshold(self, mock_settings: Settings):
        """airdrop_pulse executes without approval for small amounts."""
        mock_settings.approval_threshold = 100.0

        mock_api = AsyncMock()
        mock_api.request_transfer = AsyncMock(return_value={"status": "submitted"})

        recipients = json.dumps([
            {"account": "GBUQWP3A", "amount": 10},
            {"account": "GBUQWP3B", "amount": 20},
        ])

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings):
            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse("token-1", recipients)

            assert result["status"] == "completed"
            assert len(result["transfers"]) == 2

    @pytest.mark.asyncio
    async def test_airdrop_pulse_requires_approval_for_large_amounts(
        self, mock_settings: Settings
    ):
        """airdrop_pulse requests approval for large total amounts."""
        mock_settings.approval_threshold = 50.0

        mock_api = AsyncMock()
        mock_api.create_approval = AsyncMock(
            return_value={"id": "approval-airdrop"}
        )

        recipients = json.dumps([
            {"account": "GBUQWP3A", "amount": 100},
            {"account": "GBUQWP3B", "amount": 100},
        ])

        with patch(
            "talos_agent.tools.stellar._api", mock_api
        ), patch("talos_agent.tools.stellar._settings", mock_settings):
            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse("token-1", recipients)

            assert result["status"] == "approval_requested"
            mock_api.create_approval.assert_called_once()


# ══════════════════════════════════════════════════════════════════════════════
# Web API Tool Tests
# ══════════════════════════════════════════════════════════════════════════════


class TestWebAPIReportActivity:
    """Test activity reporting tool."""

    @pytest.mark.asyncio
    async def test_report_activity_success(self, mock_settings: Settings):
        """report_activity submits activity to Talos Web."""
        mock_api = AsyncMock()
        mock_api.report_activity = AsyncMock(
            return_value={"id": "activity-123", "status": "recorded"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_api
        ), patch("talos_agent.tools.web_api._settings", mock_settings):
            from talos_agent.tools.web_api import report_activity

            result = await report_activity(
                type="post",
                content="Hello world",
                channel="X",
            )

            assert result["id"] == "activity-123"
            mock_api.report_activity.assert_called_once()


class TestWebAPIApprovalWorkflow:
    """Test approval request and checking."""

    @pytest.mark.asyncio
    async def test_request_approval(self, mock_settings: Settings):
        """request_approval creates approval request."""
        mock_api = AsyncMock()
        mock_api.create_approval = AsyncMock(
            return_value={"id": "approval-workflow"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_api
        ), patch("talos_agent.tools.web_api._settings", mock_settings):
            from talos_agent.tools.web_api import request_approval

            result = await request_approval(
                type="transaction",
                title="High-value purchase",
                description="Purchase premium service",
                amount=100.0,
            )

            assert result["status"] == "approval_requested"
            assert result["approval_id"] == "approval-workflow"

    @pytest.mark.asyncio
    async def test_check_approval_pending(self, mock_settings: Settings):
        """check_approval returns pending status."""
        mock_api = AsyncMock()
        mock_api.get_approval = AsyncMock(
            return_value={"id": "approval-123", "status": "pending"}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_api
        ), patch("talos_agent.tools.web_api._settings", mock_settings):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("approval-123")

            assert result["status"] == "pending"

    @pytest.mark.asyncio
    async def test_check_approval_approved(self, mock_settings: Settings):
        """check_approval returns approved status."""
        mock_api = AsyncMock()
        mock_api.get_approval = AsyncMock(
            return_value={
                "id": "approval-123",
                "status": "approved",
                "decidedBy": "patron@example.com",
            }
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_api
        ), patch("talos_agent.tools.web_api._settings", mock_settings):
            from talos_agent.tools.web_api import check_approval

            result = await check_approval("approval-123")

            assert result["status"] == "approved"
            assert result["decided_by"] == "patron@example.com"


class TestWebAPIRevenueReporting:
    """Test revenue reporting tool."""

    @pytest.mark.asyncio
    async def test_report_revenue(self, mock_settings: Settings):
        """report_revenue submits earnings record."""
        mock_api = AsyncMock()
        mock_api.report_revenue = AsyncMock(
            return_value={"id": "revenue-record", "amount": 50.0}
        )

        with patch(
            "talos_agent.tools.web_api._api", mock_api
        ), patch("talos_agent.tools.web_api._settings", mock_settings):
            from talos_agent.tools.web_api import report_revenue

            result = await report_revenue(
                amount=50.0,
                source="playbook_sale",
                tx_hash="tx-2024-001",
            )

            assert result["id"] == "revenue-record"
            mock_api.report_revenue.assert_called_once()
