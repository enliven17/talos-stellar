"""Focused coverage for #1446: timeout after signing is distinct from
payment failure, and a repeat purchase does not sign a second payment."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from talos_agent.payments import USDC_TESTNET_ISSUER
from talos_agent.tools.commerce import purchase_service


def _api_402(price=1.0):
    return MagicMock(
        status_code=402,
        json=lambda: {"price": price, "payee": "GDEST...", "token": "0x", "chainId": 1},
    )


def _settings():
    s = MagicMock()
    s.approval_threshold = "50"
    s.talos_id = "talos-test"
    return s


def _db(unknown=None):
    db = MagicMock()
    db.get_talos_config.return_value = {"gtmBudget": 200}
    db.get_spending_period.return_value = 0.0
    db.add_commerce_job.return_value = None
    db.update_commerce_status.return_value = None
    db.record_spending.return_value = None
    db.find_unknown_commerce_job.return_value = unknown
    return db


def _signer():
    signer = MagicMock()
    signer.initialize = AsyncMock()
    signer.sign_payment = AsyncMock(return_value={
        "status": "signed",
        "payment_header": "x402-hdr",
    })
    return signer


@pytest.mark.asyncio
async def test_timeout_after_signing_returns_unknown_and_records_it():
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402())
    mock_api.submit_commerce = AsyncMock(side_effect=httpx.TimeoutException("simulated"))
    signer = _signer()
    db = _db()

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", db), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=signer):
        result = await purchase_service("other-talos", "analytics", "{}")

    assert result["status"] == "payment_outcome_unknown"
    assert result["code"] == "PURCHASE_TIMEOUT"
    assert "idempotency_key" in result
    signer.sign_payment.assert_called_once()
    # An unknown record was persisted so a restart can reconcile.
    db.add_commerce_job.assert_called_once()
    call_kwargs = db.add_commerce_job.call_args.kwargs
    assert call_kwargs["payload"]["_status"] == "payment_outcome_unknown"
    assert call_kwargs["payload"]["_idempotency_key"] == result["idempotency_key"]


@pytest.mark.asyncio
async def test_repeat_purchase_does_not_sign_again():
    existing = {
        "job_id": "unknown-abc",
        "idempotency_key": "abc",
    }
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402())
    signer = _signer()
    db = _db(unknown=existing)

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", db), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=signer):
        result = await purchase_service("other-talos", "analytics", "{}")

    assert result["status"] == "payment_outcome_unknown"
    signer.sign_payment.assert_not_called()
    mock_api.submit_commerce.assert_not_called()


@pytest.mark.asyncio
async def test_server_error_json_is_still_payment_failure():
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402())
    mock_api.submit_commerce = AsyncMock(return_value={"error": "payment rejected"})
    signer = _signer()
    db = _db()

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", db), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=signer):
        result = await purchase_service("other-talos", "analytics", "{}")

    assert result.get("error") == "payment rejected"
    # No unknown record on a definitive payment failure.
    db.add_commerce_job.assert_not_called()


@pytest.mark.asyncio
async def test_success_path_is_unchanged():
    mock_api = MagicMock()
    mock_api.get_service = AsyncMock(return_value=_api_402())
    mock_api.submit_commerce = AsyncMock(return_value={"jobId": "job-1", "status": "submitted"})
    signer = _signer()
    db = _db()

    with patch("talos_agent.tools.commerce._api", mock_api), \
         patch("talos_agent.tools.commerce._db", db), \
         patch("talos_agent.tools.commerce._settings", _settings()), \
         patch("talos_agent.tools.commerce._get_signer", return_value=signer):
        result = await purchase_service("other-talos", "analytics", "{}")

    assert result["status"] == "submitted"
    assert result["job_id"] == "job-1"
    signer.sign_payment.assert_called_once()
    db.add_commerce_job.assert_called_once()
    db.record_spending.assert_called_once()
