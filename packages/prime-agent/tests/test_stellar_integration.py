"""Integration tests for StellarKit (balance queries, transfers) and X402Signer (payment signing)."""

from __future__ import annotations

import pytest
import respx
from httpx import Response
from unittest.mock import AsyncMock

from talos_agent.payments import USDC_MAINNET_ISSUER, USDC_TESTNET_ISSUER
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

        assert result["balance_xlm"] == "100.5000000"
        assert str(result["balance_xlm_decimal"]) == "100.5000000"
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

        assert result["balance_xlm"] == "0.0000000"

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

    # ── Account-ID validation (issue #893) ──────────────────────────────────

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "bad_id",
        [
            "../ledgers",                          # path traversal
            "../../etc/passwd",                    # deep path traversal
            "http://evil.example.com",             # URL injection
            "SCZANGBA5YELQU563LZUAQDPQ63DXVQEMD6DKYL7VQNUXT7OACN7JXHW",  # secret key (S…)
            "notanaccountid",                       # plain string
            "",                                    # empty
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" + "X" * 5,  # too long
            "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",  # invalid checksum
        ],
    )
    async def test_get_balance_invalid_account_id_never_calls_http(
        self, bad_id: str
    ):
        """get_balance returns invalid_account error without making any HTTP call."""
        mock_api = AsyncMock()
        mock_api.get_talos = AsyncMock(
            return_value={"stellarAccountId": bad_id}
        )
        mock_api._talos_id = "test-talos"

        kit = StellarKit(mock_api)
        await kit.initialize()

        # No respx mock registered — any real HTTP call would raise an error
        with respx.mock(assert_all_called=False):
            result = await kit.get_balance(bad_id)

        assert result.get("error") == "invalid_account"
        # Confirm no HTTP routes were matched (i.e. none were called)
        assert respx.calls.call_count == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "bad_id",
        [
            "../ledgers",
            "../../etc/passwd",
            "http://evil.example.com",
            "SCZANGBA5YELQU563LZUAQDPQ63DXVQEMD6DKYL7VQNUXT7OACN7JXHW",
            "notanaccountid",
            "",
            "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        ],
    )
    async def test_get_token_balance_invalid_account_id_never_calls_http(
        self, bad_id: str
    ):
        """get_token_balance returns invalid_account error without making any HTTP call."""
        mock_api = AsyncMock()
        kit = StellarKit(mock_api)
        await kit.initialize()

        with respx.mock(assert_all_called=False):
            result = await kit.get_token_balance(bad_id, "USDC")

        assert result.get("error") == "invalid_account"
        assert respx.calls.call_count == 0

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

        assert result["balance"] == "1000.0000000"
        assert str(result["balance_decimal"]) == "1000.0000000"
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

        assert result["balance"] == "0.0000000"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_multiple_usdc_lines_defaults_to_configured_issuer(self):
        """get_token_balance defaults USDC to configured issuer and ignores fake-issuer asset."""
        mock_api = AsyncMock()
        fake_issuer = "GBFAKEISSUER77777777777777777777777777777777777777777777777"
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {"balance": "100.0000000", "asset_type": "native"},
                {
                    "balance": "999.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": fake_issuer,
                },
                {
                    "balance": "250.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")

        # Must report the real balance, NOT the fake one
        assert result["balance"] == 250.0
        assert result["token_id"] == "USDC"
        assert result["asset_issuer"] == USDC_TESTNET_ISSUER

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_fake_usdc_only_returns_zero(self):
        """A fake-issuer asset with the same code is not counted when canonical asset is missing."""
        mock_api = AsyncMock()
        fake_issuer = "GBFAKEISSUER77777777777777777777777777777777777777777777777"
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "999.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": fake_issuer,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")

        # Fake USDC is not counted
        assert result["balance"] == 0.0

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_code_colon_issuer_identifier(self):
        """get_token_balance parses CODE:ISSUER identifier correctly."""
        mock_api = AsyncMock()
        fake_issuer = "GBFAKEISSUER77777777777777777777777777777777777777777777777"
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "999.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": fake_issuer,
                },
                {
                    "balance": "250.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        # Query fake issuer explicitly via CODE:ISSUER
        res_fake = await kit.get_token_balance(account_id, f"USDC:{fake_issuer}")
        assert res_fake["balance"] == 999.0
        assert res_fake["asset_issuer"] == fake_issuer

        # Query real issuer explicitly via CODE:ISSUER
        res_real = await kit.get_token_balance(account_id, f"USDC:{USDC_TESTNET_ISSUER}")
        assert res_real["balance"] == 250.0
        assert res_real["asset_issuer"] == USDC_TESTNET_ISSUER

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_separate_issuer_argument(self):
        """get_token_balance accepts separate issuer argument."""
        mock_api = AsyncMock()
        fake_issuer = "GBFAKEISSUER77777777777777777777777777777777777777777777777"
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "999.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": fake_issuer,
                },
                {
                    "balance": "250.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        res = await kit.get_token_balance(account_id, "USDC", issuer=fake_issuer)
        assert res["balance"] == 999.0
        assert res["asset_issuer"] == fake_issuer

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_ambiguous_identifier_error(self):
        """Structured error returned when multiple assets share the same code with no issuer."""
        mock_api = AsyncMock()
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
        issuer_1 = "GB11111111111111111111111111111111111111111111111111111111"
        issuer_2 = "GB22222222222222222222222222222222222222222222222222222222"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "100.0000000",
                    "asset_type": "credit_alphanum12",
                    "asset_code": "PULSE",
                    "asset_issuer": issuer_1,
                },
                {
                    "balance": "200.0000000",
                    "asset_type": "credit_alphanum12",
                    "asset_code": "PULSE",
                    "asset_issuer": issuer_2,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        # No issuer specified for non-default token PULSE -> ambiguous!
        result = await kit.get_token_balance(account_id, "PULSE")

        assert "error" in result
        assert result["error_code"] == "ambiguous_asset"
        assert result["failure_code"] == "ambiguous_asset"
        assert result["failure_class"] == "permanent"
        assert result["terminal"] is True
        assert set(result["matching_issuers"]) == {issuer_1, issuer_2}

        # Passing an explicit issuer disambiguates successfully
        disambiguated = await kit.get_token_balance(account_id, f"PULSE:{issuer_2}")
        assert disambiguated["balance"] == 200.0

    @pytest.mark.asyncio
    async def test_get_token_balance_conflicting_issuer_error(self):
        """Structured error returned when token_id and issuer argument conflict."""
        mock_api = AsyncMock()
        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "USDC:GB11111111111111111111111111111111111111111111111111111111",
            issuer="GB22222222222222222222222222222222222222222222222222222222",
        )

        assert "error" in result
        assert result["error_code"] == "conflicting_issuer"
        assert result["terminal"] is True

    @pytest.mark.asyncio
    async def test_get_token_balance_invalid_identifier_error(self):
        """Structured error returned when token_id is malformed."""
        mock_api = AsyncMock()
        kit = StellarKit(mock_api)
        await kit.initialize()

        # Extra colons
        res1 = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "USDC:ISSUER1:EXTRA",
        )
        assert res1["error_code"] == "invalid_identifier"

        # Empty token_id
        res2 = await kit.get_token_balance(
            "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV",
            "",
        )
        assert res2["error_code"] == "invalid_identifier"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_configured_custom_usdc_issuer(self, monkeypatch):
        """Configured STELLAR_USDC_ISSUER env var overrides testnet default."""
        custom_issuer = "GBCUSTOMUSDCISSUER1234567890123456789012345678901234567890"
        monkeypatch.setenv("STELLAR_USDC_ISSUER", custom_issuer)

        mock_api = AsyncMock()
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "75.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": custom_issuer,
                },
                {
                    "balance": "250.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")
        assert result["balance"] == 75.0
        assert result["asset_issuer"] == custom_issuer

    @pytest.mark.asyncio
    async def test_resolve_usdc_issuer_mainnet(self, monkeypatch):
        """resolve_usdc_issuer returns canonical mainnet issuer when configured for mainnet."""
        monkeypatch.setenv("STELLAR_NETWORK", "mainnet")
        kit = StellarKit(AsyncMock())
        assert kit.resolve_usdc_issuer() == USDC_MAINNET_ISSUER

    @pytest.mark.asyncio
    async def test_resolve_usdc_issuer_api_settings(self):
        """resolve_usdc_issuer respects stellar_usdc_issuer string on api settings."""
        settings = AsyncMock()
        settings.stellar_usdc_issuer = "GBSETTINGSISSUER1234567890123456789012345678901234567890"
        mock_api = AsyncMock()
        mock_api._settings = settings

        kit = StellarKit(mock_api)
        assert kit.resolve_usdc_issuer() == "GBSETTINGSISSUER1234567890123456789012345678901234567890"

    @pytest.mark.asyncio
    async def test_get_token_balance_no_account(self):
        """get_token_balance returns error when account_id is empty."""
        kit = StellarKit(AsyncMock())
        await kit.initialize()
        result = await kit.get_token_balance("", "USDC")
        assert "error" in result
        assert "No Stellar account configured" in result["error"]

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_duplicate_same_issuer_error(self):
        """get_token_balance returns ambiguous error if duplicate lines have identical code and issuer."""
        mock_api = AsyncMock()
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        horizon_response = {
            "id": account_id,
            "balances": [
                {
                    "balance": "100.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
                {
                    "balance": "200.0000000",
                    "asset_type": "credit_alphanum4",
                    "asset_code": "USDC",
                    "asset_issuer": USDC_TESTNET_ISSUER,
                },
            ],
        }
        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(200, json=horizon_response)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")
        assert "error" in result
        assert result["error_code"] == "ambiguous_asset"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_http_failure(self):
        """get_token_balance attaches failure classification on HTTP errors."""
        mock_api = AsyncMock()
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            return_value=Response(503)
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")
        assert "error" in result
        assert result["failure_class"] == "retryable"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_token_balance_exception_failure(self):
        """get_token_balance attaches failure classification on exceptions."""
        mock_api = AsyncMock()
        account_id = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"

        respx.get(f"https://horizon-testnet.stellar.org/accounts/{account_id}").mock(
            side_effect=Exception("network down")
        )

        kit = StellarKit(mock_api)
        await kit.initialize()

        result = await kit.get_token_balance(account_id, "USDC")
        assert "error" in result
        assert result["failure_class"] == "unknown"


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
