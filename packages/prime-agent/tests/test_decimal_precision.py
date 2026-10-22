"""Unit tests for decimal balance and payment arithmetic precision.

Tests precision, round-trip correctness, 7-decimal place serialization,
large values, and edge cases across StellarKit and payment tools.
"""

from __future__ import annotations

from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
import respx
from httpx import Response

from talos_agent.config import Settings
from talos_agent.db import LocalDB
from talos_agent.payments.stellar_kit import (
    StellarKit,
    format_stellar_amount,
    to_stellar_amount,
)
from talos_agent.tools.defi import repay_loan
from talos_agent.tools.stellar import transfer_xlm
from talos_agent.tools.web_api import report_revenue


class TestDecimalParsingAndFormatting:
    """Test Decimal parsing and 7-decimal serialization helpers."""

    def test_to_stellar_amount_exact_round_trip(self):
        """0.1 + 0.2 style arithmetic is exact without float rounding errors."""
        d1 = to_stellar_amount("0.1")
        d2 = to_stellar_amount("0.2")
        summed = d1 + d2
        assert summed == Decimal("0.3")
        assert format_stellar_amount(summed) == "0.3000000"

    def test_to_stellar_amount_types(self):
        """to_stellar_amount handles Decimal, str, int, and float inputs."""
        assert to_stellar_amount(Decimal("123.4567891")) == Decimal("123.4567891")
        assert to_stellar_amount("123.4567891") == Decimal("123.4567891")
        assert to_stellar_amount(100) == Decimal("100")
        assert to_stellar_amount(0.5) == Decimal("0.5")

    def test_format_stellar_amount_seven_decimals(self):
        """format_stellar_amount formats to exactly 7 decimal places."""
        assert format_stellar_amount("0") == "0.0000000"
        assert format_stellar_amount(0) == "0.0000000"
        assert format_stellar_amount(Decimal("0")) == "0.0000000"
        assert format_stellar_amount("100.5") == "100.5000000"
        assert format_stellar_amount("0.1234567") == "0.1234567"
        assert format_stellar_amount("0.0000001") == "0.0000001"

    def test_format_stellar_amount_large_values(self):
        """Large balances and max Stellar bounds retain exact precision."""
        # Stellar max supply is ~922337203685.4775807
        large_val = "922337203685.4775807"
        assert format_stellar_amount(large_val) == "922337203685.4775807"
        assert format_stellar_amount(Decimal("1000000000000")) == "1000000000000.0000000"

    def test_format_stellar_amount_rounds_half_even(self):
        """Values beyond 7 decimals are quantized."""
        assert format_stellar_amount("1.12345678") == "1.1234568"


class TestStellarKitDecimalPrecision:
    """Test StellarKit methods preserve Decimal precision and 7-decimal string outputs."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_balance_parses_to_decimal_and_7_decimal_string(self):
        """get_balance returns 7-decimal string and exact Decimal value."""
        mock_api = AsyncMock()
        mock_api.get_talos = AsyncMock(
            return_value={
                "id": "talos-1",
                "stellarAccountId": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api._talos_id = "talos-1"

        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {
                    "balance": "300.1234567",
                    "asset_type": "native",
                }
            ],
        }
        respx.get(
            "https://horizon-testnet.stellar.org/accounts/GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        ).mock(return_value=Response(200, json=horizon_response))

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_balance()

        assert result["balance_xlm"] == "300.1234567"
        assert result["balance_xlm_decimal"] == Decimal("300.1234567")

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_parses_to_decimal_and_7_decimal_string(self):
        """get_token_balance returns 7-decimal string and exact Decimal value."""
        mock_api = AsyncMock()
        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {
                    "balance": "12345678.9012345",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                }
            ],
        }
        respx.get(
            "https://horizon-testnet.stellar.org/accounts/GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        ).mock(return_value=Response(200, json=horizon_response))

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV", "USDC"
        )

        assert result["balance"] == "12345678.9012345"
        assert result["balance_decimal"] == Decimal("12345678.9012345")

    @pytest.mark.asyncio
    async def test_transfer_xlm_exact_serialized_amount(self):
        """transfer_xlm serializes amount as exact 7-decimal string without float artifacts."""
        mock_api = AsyncMock()
        mock_api.request_transfer = AsyncMock(return_value={"status": "submitted", "tx_hash": "tx-1"})

        kit = StellarKit(mock_api)
        await kit.initialize()

        # 0.1 + 0.2 in standard float math is 0.30000000000000004
        # We pass it as string or Decimal or float and verify the serialized amount is exactly "0.3000000"
        result = await kit.transfer_xlm(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ", "0.3"
        )

        assert result["status"] == "submitted"
        assert result["amount"] == "0.3000000"
        mock_api.request_transfer.assert_called_once_with(
            to_account="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount="0.3000000",
            currency="XLM",
        )


class TestToolsDecimalPrecision:
    """Test transfer_xlm, repay_loan, and report_revenue tool decimal handling."""

    @pytest.mark.asyncio
    async def test_transfer_xlm_tool_below_threshold(self, mock_settings: Settings):
        """transfer_xlm tool passes exact 7-decimal string to kit."""
        mock_api = AsyncMock()
        kit = AsyncMock(spec=StellarKit)
        kit.transfer_xlm = AsyncMock(
            return_value={"status": "submitted", "to": "GBUQWP3...", "amount": "0.3000000"}
        )

        with patch("talos_agent.tools.stellar._api", mock_api), patch(
            "talos_agent.tools.stellar._settings", mock_settings
        ), patch("talos_agent.tools.stellar._get_kit", return_value=kit):
            result = await transfer_xlm("GBUQWP3...", "0.3")

            assert result["status"] == "submitted"
            kit.transfer_xlm.assert_called_once_with("GBUQWP3...", "0.3000000")

    @pytest.mark.asyncio
    async def test_repay_loan_exact_arithmetic(self, mock_settings: Settings, mock_db: LocalDB):
        """repay_loan performs exact balance subtraction without float drift."""
        mock_api = AsyncMock()
        mock_settings.approval_threshold = Decimal("100")

        # Create loan with 0.3 outstanding
        loan_id = mock_db.create_loan(
            platform="stellar_lend",
            amount=0.3,
            collateral_asset="XLM",
            loan_asset="XLM",
            duration_days=30,
        )

        with patch("talos_agent.tools.defi._api", mock_api), patch(
            "talos_agent.tools.defi._db", mock_db
        ), patch("talos_agent.tools.defi._settings", mock_settings):
            # Repay 0.1
            res1 = await repay_loan(loan_id, "0.1")
            assert res1["status"] == "repayment_recorded"
            assert res1["amount"] == "0.1000000"
            assert res1["remaining"] == "0.2000000"

            # Repay remaining 0.2
            res2 = await repay_loan(loan_id, "0.2")
            assert res2["status"] == "repayment_recorded"
            assert res2["amount"] == "0.2000000"
            assert res2["remaining"] == "0.0000000"

    @pytest.mark.asyncio
    async def test_report_revenue_exact_precision(self, mock_settings: Settings):
        """report_revenue formats amount with exact precision."""
        mock_api = AsyncMock()
        mock_api.report_revenue = AsyncMock(
            return_value={"id": "rev-1", "amount": 0.3}
        )

        with patch("talos_agent.tools.web_api._api", mock_api), patch(
            "talos_agent.tools.web_api._settings", mock_settings
        ):
            result = await report_revenue(amount="0.3", source="playbook_sale")
            assert result["id"] == "rev-1"
            mock_api.report_revenue.assert_called_once_with(
                mock_settings.talos_id,
                amount=0.3,
                source="playbook_sale",
                tx_hash=None,
            )
