"""Tests for commerce tools — price conversion, categories, budget enforcement."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from talos_agent.payments import USDC_DECIMALS, USDC_TESTNET_ISSUER, USDC_UNIT_SCALE
from talos_agent.tools.commerce import (
    ALL_CATEGORIES,
    MAX_QUOTE_COMPARISON_CANDIDATES,
    apply_playbook,
    compare_service_quotes,
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


def _quote_response(status_code: int, body: dict) -> MagicMock:
    response = MagicMock()
    response.status_code = status_code
    response.json = MagicMock(return_value=body)
    response.text = ""
    return response


def _402_body(price, *, expires_at=None, service_name="svc", **extra):
    body = {
        "price": price,
        "payee": "GDEST...",
        "currency": "USDC",
        "serviceName": service_name,
        "fulfillmentMode": "instant",
        "talosId": "seller",
    }
    body.update(extra)
    if expires_at is not None:
        body["quote"] = {"amount": str(price), "expiresAt": expires_at}
    return body


class TestCompareServiceQuotes:
    """Dry-run quote comparison: price/capability/expiry, no paid calls."""

    @pytest.mark.asyncio
    async def test_ranks_eligible_quotes_by_price_then_expiry(self):
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        near = (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        far = (now + timedelta(hours=2)).isoformat().replace("+00:00", "Z")

        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            side_effect=lambda talos_id, service_type=None: _quote_response(
                402,
                {
                    "expensive": _402_body("2.00", expires_at=near, service_name="analytics"),
                    "cheap": _402_body("1.00", service_name="research"),
                    "mid": _402_body("1.50", expires_at=far, service_name="design"),
                }[talos_id],
            )
        )
        mock_api.submit_commerce = AsyncMock()

        candidates = (
            '[{"talos_id": "expensive"}, {"talos_id": "cheap"}, {"talos_id": "mid"}]'
        )
        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes(candidates)

        assert result["status"] == "compared"
        assert result["dry_run"] is True
        assert result["payment_executed"] is False
        assert result["eligible_count"] == 3
        assert result["candidates_evaluated"] == 3
        assert result["candidates_dropped"] == 0

        quotes = result["quotes"]
        assert [q["talos_id"] for q in quotes] == ["cheap", "mid", "expensive"]
        assert [q["rank"] for q in quotes] == [1, 2, 3]
        assert quotes[0]["price_usdc"] == 1_000_000
        assert quotes[1]["price_usdc"] == 1_500_000
        assert quotes[2]["price_usdc"] == 2_000_000
        # capability + expiry surfaced for comparison
        assert quotes[1]["capability"] == "design"
        assert quotes[1]["expires_at"] is not None
        assert quotes[0]["expires_at"] is None  # legacy quote-less 402
        assert result["best_quote"]["talos_id"] == "cheap"

        # GET-only: the comparison must never reach the paid submit path.
        mock_api.submit_commerce.assert_not_called()
        assert mock_api.get_service.await_count == 3

    @pytest.mark.asyncio
    async def test_expired_quote_is_ineligible_with_code(self):
        from datetime import datetime, timedelta, timezone

        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace(
            "+00:00", "Z"
        )
        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            return_value=_quote_response(402, _402_body("1.00", expires_at=past))
        )
        mock_api.submit_commerce = AsyncMock()

        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes('[{"talos_id": "seller-a"}]')

        quote = result["quotes"][0]
        assert quote["eligible"] is False
        assert quote["code"] == "EXPIRED_QUOTE"
        assert quote["expires_at"] is not None
        assert result["eligible_count"] == 0
        assert result["best_quote"] is None
        mock_api.submit_commerce.assert_not_called()

    @pytest.mark.asyncio
    async def test_quote_expiring_too_soon_is_ineligible(self):
        """Boundary: a quote inside the settlement margin fails closed."""
        from datetime import datetime, timedelta, timezone

        soon = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat().replace(
            "+00:00", "Z"
        )
        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            return_value=_quote_response(402, _402_body("1.00", expires_at=soon))
        )

        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes('[{"talos_id": "seller-a"}]')

        quote = result["quotes"][0]
        assert quote["eligible"] is False
        assert quote["code"] == "INSUFFICIENT_VALIDITY"

    @pytest.mark.asyncio
    async def test_malformed_price_is_ineligible_not_raised(self):
        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            return_value=_quote_response(402, _402_body("not-a-price"))
        )
        mock_api.submit_commerce = AsyncMock()

        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes('[{"talos_id": "seller-a"}]')

        quote = result["quotes"][0]
        assert quote["eligible"] is False
        assert quote["code"] == "INVALID_QUOTE"
        mock_api.submit_commerce.assert_not_called()

    @pytest.mark.asyncio
    async def test_non_402_and_fetch_failures_are_ineligible_rows(self):
        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            side_effect=[
                _quote_response(404, {"error": "no service"}),
                RuntimeError("connection reset"),
            ]
        )

        candidates = '[{"talos_id": "missing"}, {"talos_id": "down"}]'
        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes(candidates)

        assert result["eligible_count"] == 0
        codes = {q["talos_id"]: q["code"] for q in result["quotes"]}
        assert codes == {"missing": "NO_QUOTE", "down": "FETCH_FAILED"}
        # Privacy: only the exception type is surfaced, never the message.
        by_id = {q["talos_id"]: q for q in result["quotes"]}
        assert by_id["down"]["error_type"] == "RuntimeError"

    @pytest.mark.asyncio
    async def test_candidate_set_is_bounded(self):
        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            return_value=_quote_response(402, _402_body("1.00"))
        )

        candidates = json.dumps(
            [{"talos_id": f"seller-{i}"} for i in range(MAX_QUOTE_COMPARISON_CANDIDATES + 2)]
        )
        with patch("talos_agent.tools.commerce._api", mock_api):
            result = await compare_service_quotes(candidates)

        assert result["candidates_requested"] == MAX_QUOTE_COMPARISON_CANDIDATES + 2
        assert result["candidates_evaluated"] == MAX_QUOTE_COMPARISON_CANDIDATES
        assert result["candidates_dropped"] == 2
        assert mock_api.get_service.await_count == MAX_QUOTE_COMPARISON_CANDIDATES

    @pytest.mark.asyncio
    async def test_invalid_candidates_payload_rejected(self):
        mock_api = MagicMock()
        with patch("talos_agent.tools.commerce._api", mock_api):
            bad_json = await compare_service_quotes("not json")
            empty = await compare_service_quotes("[]")
            missing_id = await compare_service_quotes('[{"service_type": "x"}]')

        assert bad_json["code"] == "INVALID_CANDIDATES"
        assert empty["code"] == "INVALID_CANDIDATES"
        assert missing_id["quotes"][0]["code"] == "INVALID_CANDIDATE"
        mock_api.get_service.assert_not_called()

    @pytest.mark.asyncio
    async def test_never_invokes_signer_or_spending(self):
        """Regression: comparison is GET-only — no signer, no spending record."""
        mock_signer = MagicMock()
        mock_signer.initialize = AsyncMock()
        mock_signer.sign_payment = AsyncMock()
        mock_db = MagicMock()

        mock_api = MagicMock()
        mock_api.get_service = AsyncMock(
            return_value=_quote_response(402, _402_body("1.00", expires_at=None))
        )
        mock_api.submit_commerce = AsyncMock()

        with patch("talos_agent.tools.commerce._api", mock_api), \
             patch("talos_agent.tools.commerce._db", mock_db), \
             patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer) as get_signer:
            await compare_service_quotes('[{"talos_id": "seller-a"}]')

        get_signer.assert_not_called()
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
