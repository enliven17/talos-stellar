"""Focused coverage for #1440: purchase preview exposes the applied quote
clock-policy without signatures, and reuses the existing verdict."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from talos_agent.clock import FakeClock
from talos_agent.commerce_quote import (
    DEFAULT_X402_CLOCK_SKEW_POLICY,
    EXPIRED_QUOTE,
    INSUFFICIENT_VALIDITY,
    quote_clock_policy_diagnostics,
)
from talos_agent.tools.commerce import preview_purchase

FIXED_NOW = __import__("datetime").datetime(2026, 5, 28, 12, 0, 0, tzinfo=__import__("datetime").timezone.utc)


def _quote(seconds_from_now: float) -> dict:
    expires = (FIXED_NOW + timedelta(seconds=seconds_from_now)).isoformat().replace("+00:00", "Z")
    return {"price": 1.0, "payee": "GDEST...", "quote": {"expiresAt": expires, "amount": "1.0"}}


def _api_402(details: dict):
    return MagicMock(status_code=402, json=lambda: details)


def _settings():
    s = MagicMock()
    s.approval_threshold = "50"
    s.talos_id = "talos-test"
    return s


def _db():
    db = MagicMock()
    db.get_talos_config.return_value = {"gtmBudget": 200}
    db.get_spending_period.return_value = 0.0
    return db


def test_accessor_reports_fresh_quote_with_positive_remaining():
    diagnostics = quote_clock_policy_diagnostics(
        _quote(3600),
        clock=FakeClock(FIXED_NOW),
        policy=DEFAULT_X402_CLOCK_SKEW_POLICY,
    )
    assert diagnostics["verdict"] is None
    assert diagnostics["max_clock_skew_secs"] == DEFAULT_X402_CLOCK_SKEW_POLICY.max_clock_skew_secs
    assert (
        diagnostics["min_remaining_validity_secs"]
        == DEFAULT_X402_CLOCK_SKEW_POLICY.min_remaining_validity_secs
    )
    assert diagnostics["remaining_validity_secs"] > 0


def test_accessor_reuses_verdict_at_exact_expiry():
    # now == expires_at → the existing verdict says EXPIRED_QUOTE
    diagnostics = quote_clock_policy_diagnostics(
        _quote(0),
        clock=FakeClock(FIXED_NOW),
        policy=DEFAULT_X402_CLOCK_SKEW_POLICY,
    )
    assert diagnostics["verdict"] == EXPIRED_QUOTE
    assert diagnostics["remaining_validity_secs"] <= 0


def test_accessor_reuses_verdict_inside_settlement_margin():
    # Positive remaining validity but less than min_remaining_validity_secs
    margin = DEFAULT_X402_CLOCK_SKEW_POLICY.min_remaining_validity_secs
    diagnostics = quote_clock_policy_diagnostics(
        _quote(margin - 1),
        clock=FakeClock(FIXED_NOW),
        policy=DEFAULT_X402_CLOCK_SKEW_POLICY,
    )
    assert diagnostics["verdict"] == INSUFFICIENT_VALIDITY
    assert diagnostics["remaining_validity_secs"] > 0


@pytest.mark.asyncio
async def test_preview_attaches_clock_policy_and_signs_nothing():
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402(_quote(3600)))
    mock_api.submit_commerce = AsyncMock()
    mock_signer = MagicMock()
    mock_signer.sign_payment = AsyncMock()

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", _db()), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer):
        result = await preview_purchase("other-talos", "analytics", "{}")

    assert result["status"] == "preview"
    assert "clock_policy" in result
    cp = result["clock_policy"]
    assert cp["verdict"] is None
    assert cp["max_clock_skew_secs"] == DEFAULT_X402_CLOCK_SKEW_POLICY.max_clock_skew_secs
    assert cp["min_remaining_validity_secs"] == DEFAULT_X402_CLOCK_SKEW_POLICY.min_remaining_validity_secs
    # Nothing in the preview is a signature, a header, or a payment proof.
    assert "payment_header" not in result
    assert "signature" not in result
    assert "payment_proof" not in result
    # And no signing or submission side effect occurred.
    mock_signer.sign_payment.assert_not_called()
    mock_api.submit_commerce.assert_not_called()


@pytest.mark.asyncio
async def test_preview_returns_rejected_verdict_with_clock_policy():
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402(_quote(-10)))
    mock_api.submit_commerce = AsyncMock()
    mock_signer = MagicMock()
    mock_signer.sign_payment = AsyncMock()

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", _db()), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=mock_signer):
        result = await preview_purchase("other-talos", "analytics", "{}")

    # The existing verdict is returned and its code is EXPIRED_QUOTE.
    assert result.get("code") == EXPIRED_QUOTE
    # And the applied clock policy is attached alongside it.
    assert "clock_policy" in result
    assert result["clock_policy"]["verdict"] == EXPIRED_QUOTE
