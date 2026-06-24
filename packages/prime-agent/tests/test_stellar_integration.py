"""Integration tests for StellarKit (balance queries, transfers) and X402Signer (payment signing)."""

from __future__ import annotations

import pytest
import respx
from httpx import Response
from unittest.mock import AsyncMock, MagicMock

from talos_agent.payments.stellar_kit import StellarKit
from talos_agent.payments.x402_signer import X402Signer


# ══════════════════════════════════════════════════════════════════════════════
# StellarKit Tests
# ══════════════════════════════════════════════════════════════════════════════


class TestStellarKitInitialization:
    """Test StellarKit setup and availability."""

    @pytest.mark.asyncio
    async def test_initialize(self):
        """Initialize sets ready state."""
        mock_api = AsyncMock()
        kit = StellarKit(mock_api)

        assert not kit.available
        await kit.initialize()
        assert kit.available

    @pytest.mark.asyncio
    async def test_initialize_idempotent(self):
        """Multiple initializations are safe (idempotent)."""
        mock_api = AsyncMock()
        kit = StellarKit(mock_api)

        await kit.initialize()
        await kit.initialize()
        assert kit.available


class TestStellarKitBalanceQueries:
    """Test XLM balance queries via Horizon."""

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_xlm_balance_success(self):
        """get_balance returns XLM balance from Horizon."""
        mock_api = AsyncMock()
        mock_api.get_talos = AsyncMock(
            return_value={
                "id": "test-talos",
                "stellarAccountId": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api._talos_id = "test-talos"

        # Mock Horizon API response
        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {
                    "balance": "100.5000000",
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

        assert result["balance_xlm"] == 100.5
        assert (
            result["account"]
            == "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        )

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_xlm_balance_zero_when_no_native_asset(self):
        """get_balance returns 0 when no native asset in balances."""
        mock_api = AsyncMock()
        mock_api.get_talos = AsyncMock(
            return_value={
                "stellarAccountId": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
            }
        )
        mock_api._talos_id = "test-talos"

        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {
                    "balance": "500.0000000",
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
        result = await kit.get_balance()

        assert result["balance_xlm"] == 0

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_xlm_balance_no_account_configured(self):
        """get_balance returns error when no Stellar account configured."""
        mock_api = AsyncMock()
        mock_api.get_talos = AsyncMock(return_value={"id": "test-talos"})
        mock_api._talos_id = "test-talos"

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_balance()

        assert "error" in result
        assert "No Stellar account" in result["error"]

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance(self):
        """get_token_balance returns balance for specific token."""
        mock_api = AsyncMock()

        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {"balance": "100.0000000", "asset_type": "native"},
                {
                    "balance": "250.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                },
                {
                    "balance": "1000.0000000",
                    "asset_type": "credit_alphanum12",
                    "asset_code": "PULSE",
                },
            ],
        }
        respx.get(
            "https://horizon-testnet.stellar.org/accounts/GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        ).mock(return_value=Response(200, json=horizon_response))

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV", "PULSE"
        )

        assert result["balance"] == 1000.0
        assert result["token_id"] == "PULSE"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_not_found(self):
        """get_token_balance returns 0 when token not in balances."""
        mock_api = AsyncMock()

        horizon_response = {
            "id": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "balances": [
                {"balance": "100.0000000", "asset_type": "native"},
            ],
        }
        respx.get(
            "https://horizon-testnet.stellar.org/accounts/GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        ).mock(return_value=Response(200, json=horizon_response))

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV", "NOTFOUND"
        )

        assert result["balance"] == 0


class TestStellarKitTransfers:
    """Test Stellar transfer operations via Web API."""

    @pytest.mark.asyncio
    async def test_transfer_xlm_success(self):
        """transfer_xlm requests XLM transfer via API."""
        mock_api = AsyncMock()
        mock_api.request_transfer = AsyncMock(
            return_value={"status": "submitted", "tx_hash": "abc123"}
        )

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.transfer_xlm(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ", 50.0
        )

        assert result["status"] == "submitted"
        mock_api.request_transfer.assert_called_once()

    @pytest.mark.asyncio
    async def test_transfer_xlm_api_failure(self):
        """transfer_xlm returns error on API failure."""
        mock_api = AsyncMock()
        mock_api.request_transfer = AsyncMock(return_value=None)

        kit = StellarKit(mock_api)
        await kit.initialize()
        result = await kit.transfer_xlm(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ", 50.0
        )

        assert "error" in result


# ══════════════════════════════════════════════════════════════════════════════
# X402Signer Tests
# ══════════════════════════════════════════════════════════════════════════════


class TestX402SignerInitialization:
    """Test X402Signer wallet setup."""

    @pytest.mark.asyncio
    async def test_initialize_success(self):
        """initialize fetches wallet from API."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
                "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
            }
        )

        signer = X402Signer(mock_api)
        assert not signer.available

        await signer.initialize()
        assert signer.available
        assert signer.address == "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        assert signer._wallet_id == "circle-wallet-123"

    @pytest.mark.asyncio
    async def test_initialize_no_wallet(self):
        """initialize handles missing wallet gracefully."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(return_value=None)

        signer = X402Signer(mock_api)
        await signer.initialize()

        assert not signer.available

    @pytest.mark.asyncio
    async def test_initialize_idempotent(self):
        """initialize only fetches wallet once."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )

        signer = X402Signer(mock_api)
        await signer.initialize()
        await signer.initialize()
        await signer.initialize()

        # Should only call API once
        mock_api.get_agent_wallet.assert_called_once()


class TestX402SignerPaymentSigning:
    """Test x402 payment signature generation."""

    @pytest.mark.asyncio
    async def test_sign_payment_success(self):
        """sign_payment requests signature and returns payment header."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(
            return_value={
                "paymentHeader": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXllZSI6IkdCVVFXUDNCT1VaWDM0VUxOUUcyM1JRNkY0WVVTWEhUUVNYRTdFVjRFVk9UVkVWTUhHSExKTE1RIiwgImFtb3VudCI6IDEwMDAwMDB9",
                "from": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=1_000_000,
            asset_code="USDC",
        )

        assert result["status"] == "signed"
        assert "paymentHeader" in result
        assert result["to"] == "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ"
        assert result["amount"] == 1_000_000

    @pytest.mark.asyncio
    async def test_sign_payment_not_initialized(self):
        """sign_payment returns error if not initialized."""
        mock_api = AsyncMock()

        signer = X402Signer(mock_api)
        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=1_000_000,
        )

        assert "error" in result
        assert "not initialized" in result["error"]

    @pytest.mark.asyncio
    async def test_sign_payment_with_custom_issuer(self):
        """sign_payment includes asset issuer when specified."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(
            return_value={
                "paymentHeader": "Bearer signed-header...",
                "from": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=500_000,
            asset_code="PULSE",
            asset_issuer="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMX",
        )

        assert result["status"] == "signed"
        mock_api.sign_payment.assert_called_once()
        call_kwargs = mock_api.sign_payment.call_args[1]
        assert call_kwargs["asset_issuer"] == "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMX"

    @pytest.mark.asyncio
    async def test_sign_payment_api_error(self):
        """sign_payment returns error from API."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(
            return_value={
                "error": "Insufficient balance",
                "details": "Wallet balance is too low for this transfer",
            }
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=1_000_000,
        )

        assert "error" in result
        assert "Insufficient balance" in result["error"]

    @pytest.mark.asyncio
    async def test_sign_payment_exception_handling(self):
        """sign_payment handles exceptions gracefully."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "circle-wallet-123",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(side_effect=Exception("Network error"))

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=1_000_000,
        )

        assert "error" in result
        assert "Signing failed" in result["error"]


class TestX402SignerMultipleAssets:
    """Test signing for different asset types."""

    @pytest.mark.asyncio
    async def test_sign_usdc_payment(self):
        """sign_payment for USDC asset."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "wallet-1",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(
            return_value={"paymentHeader": "Bearer ...", "from": "GBUQWP3..."}
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=10_000_000,
            asset_code="USDC",
        )

        assert result["status"] == "signed"

    @pytest.mark.asyncio
    async def test_sign_native_xlm_payment(self):
        """sign_payment for native XLM asset (default)."""
        mock_api = AsyncMock()
        mock_api.get_agent_wallet = AsyncMock(
            return_value={
                "walletId": "wallet-1",
                "publicKey": "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            }
        )
        mock_api.sign_payment = AsyncMock(
            return_value={"paymentHeader": "Bearer ...", "from": "GBUQWP3..."}
        )

        signer = X402Signer(mock_api)
        await signer.initialize()

        result = await signer.sign_payment(
            payee="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMQ",
            amount=50_000_000,
            asset_code="USDC",  # Default
        )

        assert result["status"] == "signed"
