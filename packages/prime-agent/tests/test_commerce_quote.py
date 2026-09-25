"""Focused tests for commerce quote expiry enforcement."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.clock import FakeClock
from talos_agent.commerce_quote import (
    EXPIRED_QUOTE,
    INVALID_QUOTE,
    MISSING_QUOTE_EXPIRY,
    enforce_commerce_quote_expiry,
    extract_quote_expires_at,
    parse_iso8601_timestamp,
    quote_expiry_iso,
    verify_quote_not_expired,
)
from talos_agent.tools.commerce import purchase_service


FIXED_NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)


class TestParseIso8601:
    def test_zulu(self):
        dt = parse_iso8601_timestamp("2026-06-15T12:00:00Z")
        assert dt == FIXED_NOW

    def test_offset(self):
        dt = parse_iso8601_timestamp("2026-06-15T13:00:00+01:00")
        assert dt == FIXED_NOW

    def test_empty_and_malformed(self):
        assert parse_iso8601_timestamp("") is None
        assert parse_iso8601_timestamp(None) is None
        assert parse_iso8601_timestamp(123) is None
        assert parse_iso8601_timestamp("not-a-date") is None
        assert parse_iso8601_timestamp("yesterday") is None


class TestExtractQuoteExpiresAt:
    def test_prefers_nested_quote(self):
        raw = extract_quote_expires_at(
            {
                "expiresAt": "2026-01-01T00:00:00Z",
                "quote": {"expiresAt": "2026-12-31T00:00:00Z"},
            }
        )
        assert raw == "2026-12-31T00:00:00Z"

    def test_top_level_fallback(self):
        assert extract_quote_expires_at({"expires_at": "2026-07-01T00:00:00Z"}) == (
            "2026-07-01T00:00:00Z"
        )

    def test_missing(self):
        assert extract_quote_expires_at({"price": 1}) is None
        assert extract_quote_expires_at(None) is None


class TestVerifyQuoteNotExpired:
    def test_future_valid(self):
        clock = FakeClock(FIXED_NOW)
        assert verify_quote_not_expired(
            datetime(2026, 6, 15, 12, 0, 1, tzinfo=timezone.utc),
            clock=clock,
        )

    def test_boundary_instant_is_expired(self):
        clock = FakeClock(FIXED_NOW)
        assert not verify_quote_not_expired(FIXED_NOW, clock=clock)

    def test_past_expired(self):
        clock = FakeClock(FIXED_NOW)
        assert not verify_quote_not_expired(
            datetime(2026, 6, 15, 11, 59, 59, tzinfo=timezone.utc),
            clock=clock,
        )


class TestEnforceCommerceQuoteExpiry:
    def test_valid_nested_quote(self):
        clock = FakeClock(FIXED_NOW)
        err = enforce_commerce_quote_expiry(
            {
                "price": 1.0,
                "quote": {
                    "amount": "1.000000",
                    "expiresAt": "2026-06-15T13:00:00Z",
                },
            },
            clock=clock,
        )
        assert err is None

    def test_expired_quote(self):
        clock = FakeClock(FIXED_NOW)
        err = enforce_commerce_quote_expiry(
            {"quote": {"expiresAt": "2026-06-15T11:00:00Z"}},
            clock=clock,
        )
        assert err is not None
        assert err["code"] == EXPIRED_QUOTE
        assert "signature" not in err
        assert "expires_at" in err

    def test_malformed_expiry(self):
        err = enforce_commerce_quote_expiry(
            {"quote": {"expiresAt": "soon"}},
            clock=FakeClock(FIXED_NOW),
        )
        assert err["code"] == INVALID_QUOTE

    def test_quote_object_missing_expiry(self):
        err = enforce_commerce_quote_expiry(
            {"quote": {"amount": "1.000000"}},
            clock=FakeClock(FIXED_NOW),
        )
        assert err["code"] == INVALID_QUOTE

    def test_missing_when_required(self):
        err = enforce_commerce_quote_expiry(
            {"price": 1.0, "payee": "G..."},
            clock=FakeClock(FIXED_NOW),
            require_expiry=True,
        )
        assert err["code"] == MISSING_QUOTE_EXPIRY

    def test_legacy_allowed_without_expiry(self):
        err = enforce_commerce_quote_expiry(
            {"price": 1.0, "payee": "G..."},
            clock=FakeClock(FIXED_NOW),
            require_expiry=False,
        )
        assert err is None

    def test_quote_expiry_iso_helper(self):
        assert (
            quote_expiry_iso({"expiresAt": "2026-06-15T12:00:00+00:00"})
            == "2026-06-15T12:00:00Z"
        )


def _mock_purchase_env(payment_details: dict):
    mock_sign = AsyncMock(return_value={"status": "signed", "payment_header": "hdr"})
    mock_signer = MagicMock()
    mock_signer.initialize = AsyncMock()
    mock_signer.sign_payment = mock_sign

    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(
        return_value=MagicMock(status_code=402, json=lambda: payment_details)
    )
    mock_api.submit_commerce = AsyncMock(
        return_value={"jobId": "job-1", "status": "submitted"}
    )

    mock_db = MagicMock()
    mock_db.get_talos_config.return_value = {"gtmBudget": 200}
    mock_db.get_spending_period.return_value = 0.0
    mock_db.add_commerce_job.return_value = None
    mock_db.record_spending.return_value = None

    mock_settings = MagicMock()
    mock_settings.approval_threshold = "50"
    mock_settings.talos_id = "talos-test"

    return mock_api, mock_db, mock_settings, mock_signer, mock_sign


class TestPurchaseServiceQuoteExpiry:
    @pytest.mark.asyncio
    async def test_rejects_expired_quote_before_signing(self):
        details = {
            "price": 1.0,
            "payee": "GDEST...",
            "quote": {
                "amount": "1.000000",
                "expiresAt": "2020-01-01T00:00:00Z",
            },
        }
        mock_api, mock_db, mock_settings, mock_signer, mock_sign = _mock_purchase_env(details)

        with patch("talos_agent.tools.commerce._api", mock_api), patch(
            "talos_agent.tools.commerce._db", mock_db
        ), patch("talos_agent.tools.commerce._settings", mock_settings), patch(
            "talos_agent.tools.commerce._get_signer", return_value=mock_signer
        ):
            result = await purchase_service("other-talos", "analytics", "{}")

        assert result["code"] == EXPIRED_QUOTE
        mock_sign.assert_not_called()
        mock_api.submit_commerce.assert_not_called()

    @pytest.mark.asyncio
    async def test_accepts_valid_quote_and_persists_expiry(self):
        future = "2099-01-01T00:00:00Z"
        details = {
            "price": 1.0,
            "payee": "GDEST...",
            "quote": {"amount": "1.000000", "expiresAt": future},
        }
        mock_api, mock_db, mock_settings, mock_signer, mock_sign = _mock_purchase_env(details)

        with patch("talos_agent.tools.commerce._api", mock_api), patch(
            "talos_agent.tools.commerce._db", mock_db
        ), patch("talos_agent.tools.commerce._settings", mock_settings), patch(
            "talos_agent.tools.commerce._get_signer", return_value=mock_signer
        ):
            result = await purchase_service("other-talos", "analytics", "{}")

        assert result.get("status") == "submitted"
        mock_sign.assert_called_once()
        args, kwargs = mock_db.add_commerce_job.call_args
        tracked = args[3] if len(args) > 3 else kwargs.get("payload")
        assert tracked["_quote_expires_at"] == future

    @pytest.mark.asyncio
    async def test_legacy_402_without_quote_still_works(self):
        details = {"price": 1.0, "payee": "GDEST..."}
        mock_api, mock_db, mock_settings, mock_signer, mock_sign = _mock_purchase_env(details)

        with patch("talos_agent.tools.commerce._api", mock_api), patch(
            "talos_agent.tools.commerce._db", mock_db
        ), patch("talos_agent.tools.commerce._settings", mock_settings), patch(
            "talos_agent.tools.commerce._get_signer", return_value=mock_signer
        ):
            result = await purchase_service("other-talos", "analytics", "{}")

        assert result.get("status") == "submitted"
        mock_sign.assert_called_once()
