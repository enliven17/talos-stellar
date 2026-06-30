"""Tests for commerce tools — price conversion, categories, budget enforcement."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from talos_agent.payments import USDC_TESTNET_ISSUER
from talos_agent.tools.commerce import (
    ALL_CATEGORIES,
    apply_playbook,
    discover_services,
    price_to_usdc_units,
    purchase_service,
)


class TestPriceToUsdcUnits:
    def test_standard_decimal(self):
        assert price_to_usdc_units("1.05") == 1_050_000

    def test_half_dollar(self):
        assert price_to_usdc_units("0.50") == 500_000

    def test_whole_number(self):
        assert price_to_usdc_units("10") == 10_000_000

    def test_six_decimals(self):
        assert price_to_usdc_units("1.999999") == 1_999_999

    def test_truncates_beyond_six(self):
        assert price_to_usdc_units("1.1234567") == 1_123_456

    def test_zero(self):
        assert price_to_usdc_units("0") == 0

    def test_smallest_unit(self):
        assert price_to_usdc_units("0.000001") == 1


def test_all_categories_has_ten_entries():
    assert len(ALL_CATEGORIES) == 10
    assert "Sales" in ALL_CATEGORIES
    assert "Education" in ALL_CATEGORIES
    assert "Development" in ALL_CATEGORIES


class MockAPIClient:
    def __init__(self):
        self.discover_services = AsyncMock(return_value=[])


@pytest.fixture
def mock_api_client():
    return MockAPIClient()


@pytest.mark.asyncio
@pytest.mark.parametrize("category", ALL_CATEGORIES)
async def test_discover_services_handles_category(category, mock_api_client):
    with patch("talos_agent.tools.commerce._api", mock_api_client), \
         patch("random.choice", return_value=category):
        res = await discover_services()
        assert res["category_searched"] == category
        mock_api_client.discover_services.assert_called_once_with(
            category=category,
            target=None
        )


class TestPurchaseServiceSignPayment:
    """Verify purchase_service forwards correct asset kwargs to sign_payment."""

    @pytest.mark.asyncio
    async def test_sign_payment_receives_asset_code_and_issuer(self):
        mock_sign = AsyncMock(return_value={
            "status": "signed",
            "payment_header": "x402-header-value",
        })
        mock_signer = MagicMock()
        mock_signer.initialize = AsyncMock()
        mock_signer.sign_payment = mock_sign

        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(return_value=MagicMock(
            status_code=402,
            json=lambda: {"price": 1.00, "payee": "GDEST...", "token": "0xabc", "chainId": 1},
        ))
        mock_api.submit_commerce = AsyncMock(return_value={"jobId": "job-1", "status": "submitted"})

        mock_db = MagicMock()
        mock_db.get_talos_config.return_value = {"gtmBudget": 200}
        mock_db.get_spending_period.return_value = 0.0
        mock_db.add_commerce_job.return_value = None
        mock_db.record_spending.return_value = None

        mock_settings = MagicMock()
        mock_settings.approval_threshold = "50"
        mock_settings.talos_id = "talos-test"

        with patch("talos_agent.tools.commerce._api", mock_api), \
             patch("talos_agent.tools.commerce._db", mock_db), \
             patch("talos_agent.tools.commerce._settings", mock_settings), \
             patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer):
            result = await purchase_service("other-talos", "analytics", "{}")

        assert "error" not in result or "TypeError" not in result.get("error", "")
        mock_sign.assert_called_once_with(
            payee="GDEST...",
            amount=1_000_000,
            asset_code="USDC",
            asset_issuer=USDC_TESTNET_ISSUER,
        )

    @pytest.mark.asyncio
    async def test_sign_payment_no_unexpected_kwargs(self):
        """token_address and chain_id must NOT appear in the sign_payment call."""
        mock_sign = AsyncMock(return_value={"status": "signed", "payment_header": "hdr"})
        mock_signer = MagicMock()
        mock_signer.initialize = AsyncMock()
        mock_signer.sign_payment = mock_sign

        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(return_value=MagicMock(
            status_code=402,
            json=lambda: {"price": 0.50, "payee": "GPAY...", "token": "0xtoken", "chainId": 42},
        ))
        mock_api.submit_commerce = AsyncMock(return_value={"jobId": "j2", "status": "submitted"})

        mock_db = MagicMock()
        mock_db.get_talos_config.return_value = {"gtmBudget": 100}
        mock_db.get_spending_period.return_value = 0.0
        mock_db.add_commerce_job.return_value = None
        mock_db.record_spending.return_value = None

        mock_settings = MagicMock()
        mock_settings.approval_threshold = "50"
        mock_settings.talos_id = "talos-test"

        with patch("talos_agent.tools.commerce._api", mock_api), \
             patch("talos_agent.tools.commerce._db", mock_db), \
             patch("talos_agent.tools.commerce._settings", mock_settings), \
             patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer):
            await purchase_service("other-talos", "research", "{}")

        _, call_kwargs = mock_sign.call_args
        assert "token_address" not in call_kwargs
        assert "chain_id" not in call_kwargs


class TestApplyPlaybook:
    @pytest.mark.asyncio
    async def test_apply_playbook_uses_exact_lookup_method(self):
        mock_db = MagicMock()
        mock_db.find_playbook_by_name.return_value = {
            "id": 7,
            "name": "Alpha Playbook",
            "data": {"stage": "launch"},
        }

        with patch("talos_agent.tools.commerce._db", mock_db):
            result = await apply_playbook("  Alpha Playbook  ")

        mock_db.find_playbook_by_name.assert_called_once_with("Alpha Playbook")
        mock_db.apply_playbook.assert_called_once_with(7)
        assert result["status"] == "applied"
        assert result["playbook"] == "Alpha Playbook"

    @pytest.mark.asyncio
    async def test_apply_playbook_rejects_blank_name(self):
        mock_db = MagicMock()

        with patch("talos_agent.tools.commerce._db", mock_db):
            result = await apply_playbook("   ")

        assert result == {"error": "Playbook name cannot be empty"}
        mock_db.find_playbook_by_name.assert_not_called()
        mock_db.apply_playbook.assert_not_called()

    @pytest.mark.asyncio
    async def test_apply_playbook_returns_not_found_for_exact_lookup_miss(self):
        mock_db = MagicMock()
        mock_db.find_playbook_by_name.return_value = None

        with patch("talos_agent.tools.commerce._db", mock_db):
            result = await apply_playbook("Growth")

        assert result == {"error": "No playbook found named 'Growth'"}
        mock_db.find_playbook_by_name.assert_called_once_with("Growth")
        mock_db.apply_playbook.assert_not_called()
