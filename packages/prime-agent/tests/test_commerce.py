"""Tests for commerce tools — price conversion, categories, budget enforcement."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from talos_agent.payments import USDC_DECIMALS, USDC_TESTNET_ISSUER, USDC_UNIT_SCALE
from talos_agent.tools.commerce import (
    ALL_CATEGORIES,
    apply_playbook,
    discover_services,
    price_to_usdc_units,
    purchase_service,
)


class TestPriceToUsdcUnits:
    @pytest.mark.parametrize(
        ("price", "expected"),
        [
            ("0", 0),
            ("0.000001", 1),
            ("0.50", 500_000),
            ("1.05", 1_050_000),
            ("1.999999", 1_999_999),
            ("10", 10_000_000),
            ("10.000000", 10_000_000),
            ("1000000", 1_000_000_000_000),
        ],
    )
    def test_valid_prices(self, price, expected):
        assert price_to_usdc_units(price) == expected

    def test_matches_unit_scale_constant(self):
        assert price_to_usdc_units("1") == USDC_UNIT_SCALE
        assert USDC_UNIT_SCALE == 10**USDC_DECIMALS

    @pytest.mark.parametrize(
        "price",
        [
            "1.2.3",  # extra dot was previously read as 1200000
            "-1",  # negative sign was previously read as -1000000
            "",  # previously raised ValueError from int('')
            "1.",
            ".5",
            "abc",
            "1.1234567",  # more precision than USDC supports
            "1e6",
            "0x10",
            "nan",
            "inf",
            " 1.05",
            "1.05 ",
            "+1.05",
            "1,05",
        ],
    )
    def test_malformed_prices_raise(self, price):
        with pytest.raises(ValueError, match="Invalid price") as exc_info:
            price_to_usdc_units(price)
        message = str(exc_info.value)
        assert repr(price) in message
        assert str(USDC_DECIMALS) in message

    def test_rejects_non_decimal_types(self):
        with pytest.raises(ValueError, match="Invalid price"):
            price_to_usdc_units(None)

    def test_accepts_numeric_inputs(self):
        assert price_to_usdc_units(1) == 1_000_000
        assert price_to_usdc_units(1.05) == 1_050_000


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


class TestPurchaseServiceRejectsMalformedPrice:
    """A price that cannot be converted exactly must not reach the signer."""

    @pytest.mark.asyncio
    async def test_over_precise_price_is_rejected_before_signing(self):
        mock_signer = MagicMock()
        mock_signer.initialize = AsyncMock()
        mock_signer.sign_payment = AsyncMock(return_value={"status": "signed"})

        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(return_value=MagicMock(
            status_code=402,
            json=lambda: {"price": "1.0000001", "payee": "GPAY..."},
        ))
        mock_api.submit_commerce = AsyncMock()

        mock_db = MagicMock()
        mock_db.get_talos_config.return_value = {"gtmBudget": 200}
        mock_db.get_spending_period.return_value = 0.0

        mock_settings = MagicMock()
        mock_settings.approval_threshold = "50"
        mock_settings.talos_id = "talos-test"

        with patch("talos_agent.tools.commerce._api", mock_api), \
             patch("talos_agent.tools.commerce._db", mock_db), \
             patch("talos_agent.tools.commerce._settings", mock_settings), \
             patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer):
            result = await purchase_service("other-talos", "research", "{}")

        assert result["code"] == "INVALID_QUOTE"
        mock_signer.sign_payment.assert_not_called()
        mock_api.submit_commerce.assert_not_called()
        mock_db.record_spending.assert_not_called()


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
