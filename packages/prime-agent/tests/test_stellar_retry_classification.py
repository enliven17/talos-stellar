"""Focused tests for Stellar transaction retry failure classification.

Matrix
------
positive    — status and exception types map to the expected class
negative    — malformed / unknown inputs degrade to ``unknown``
boundary    — status range, bool/str status, code length and charset
privacy     — no exception text, seed, or payment proof ever leaks
regression  — legacy ``error`` key and success shapes are preserved
integration — StellarKit surfaces the classification to callers

All external services are replaced with dependency-free fakes.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from talos_agent.circuit_breaker import CircuitBreakerOpen
from talos_agent.http import RetryableHTTPError
from talos_agent.payments.stellar_kit import StellarKit
from talos_agent.payments.stellar_retry import (
    StellarFailure,
    StellarRetryClass,
    attach_stellar_failure,
    classify_stellar_failure,
    classify_stellar_result,
)
from talos_agent.scheduler import run_loan_repayment

FAKE_SEED = "S" + "A" * 55
FAKE_PAYMENT_PROOF = "Bearer eyJhbGciOiJIUzI1NiJ9.payment-proof"


def _retryable_error(status: int) -> RetryableHTTPError:
    request = httpx.Request("POST", "https://api.example.com/api/talos/t/transfer")
    return RetryableHTTPError(httpx.Response(status, request=request))


# ── Positive: status mapping ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("status", "expected_class", "expected_code"),
    [
        (429, StellarRetryClass.RATE_LIMITED, "rate_limited"),
        (502, StellarRetryClass.RETRYABLE, "upstream_unavailable"),
        (503, StellarRetryClass.RETRYABLE, "upstream_unavailable"),
        (504, StellarRetryClass.RETRYABLE, "upstream_unavailable"),
        (401, StellarRetryClass.PERMANENT, "unauthorized"),
        (403, StellarRetryClass.PERMANENT, "unauthorized"),
        (402, StellarRetryClass.PERMANENT, "insufficient_funds"),
        (404, StellarRetryClass.PERMANENT, "not_found"),
        (409, StellarRetryClass.PERMANENT, "conflict"),
        (400, StellarRetryClass.PERMANENT, "invalid_request"),
        (422, StellarRetryClass.PERMANENT, "invalid_request"),
        (500, StellarRetryClass.UNKNOWN, "server_error"),
    ],
)
def test_status_code_classification(status, expected_class, expected_code):
    failure = classify_stellar_failure(status_code=status)
    assert failure.classification is expected_class
    assert failure.code == expected_code


def test_retryable_and_terminal_flags_track_classification():
    assert classify_stellar_failure(status_code=429).retryable
    assert classify_stellar_failure(status_code=503).retryable
    assert not classify_stellar_failure(status_code=503).terminal
    assert classify_stellar_failure(status_code=403).terminal
    assert not classify_stellar_failure(status_code=403).retryable
    assert classify_stellar_failure(status_code=403).indeterminate is False


# ── Positive: exception-type mapping ───────────────────────────────────────────


def test_timeout_is_indeterminate_not_silently_retried():
    failure = classify_stellar_failure(exc=httpx.TimeoutException("read timed out"))
    assert failure.classification is StellarRetryClass.INDETERMINATE
    assert failure.code == "submission_timeout"
    assert failure.indeterminate and not failure.retryable and not failure.terminal


def test_asyncio_timeout_is_indeterminate():
    failure = classify_stellar_failure(exc=asyncio.TimeoutError())
    assert failure.classification is StellarRetryClass.INDETERMINATE


def test_connect_error_is_retryable():
    failure = classify_stellar_failure(exc=httpx.ConnectError("connection refused"))
    assert failure.classification is StellarRetryClass.RETRYABLE
    assert failure.code == "transport_unavailable"


def test_circuit_breaker_open_is_retryable():
    failure = classify_stellar_failure(exc=CircuitBreakerOpen("talos_web_api", 12.5))
    assert failure.classification is StellarRetryClass.RETRYABLE
    assert failure.code == "circuit_open"


def test_exhausted_retryable_http_error_uses_status():
    failure = classify_stellar_failure(exc=_retryable_error(503))
    assert failure.classification is StellarRetryClass.RETRYABLE
    assert failure.code == "upstream_unavailable"


def test_explicit_status_wins_over_retryable_http_error_status():
    # An explicit caller-supplied status is authoritative.
    failure = classify_stellar_failure(status_code=429, exc=_retryable_error(503))
    assert failure.classification is StellarRetryClass.RATE_LIMITED


def test_generic_exception_is_unknown():
    failure = classify_stellar_failure(exc=RuntimeError("boom"))
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "unclassified"


# ── Positive: explicit bounded error codes ─────────────────────────────────────


@pytest.mark.parametrize(
    ("code", "expected_class"),
    [
        ("insufficient_funds", StellarRetryClass.PERMANENT),
        ("tx_bad_auth", StellarRetryClass.PERMANENT),
        ("invalid_destination", StellarRetryClass.PERMANENT),
        ("rate_limited", StellarRetryClass.RATE_LIMITED),
        ("submission_timeout", StellarRetryClass.INDETERMINATE),
        ("upstream_unavailable", StellarRetryClass.RETRYABLE),
    ],
)
def test_known_error_codes_classified(code, expected_class):
    failure = classify_stellar_failure(error_code=code)
    assert failure.classification is expected_class
    assert failure.code == code


def test_unknown_error_code_is_not_echoed():
    failure = classify_stellar_failure(error_code="totally_unknown_code")
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "unclassified"


def test_error_code_is_normalized_case_and_whitespace():
    failure = classify_stellar_failure(error_code="  Insufficient_Funds  ")
    assert failure.classification is StellarRetryClass.PERMANENT
    assert failure.code == "insufficient_funds"


# ── Negative: missing and malformed input ──────────────────────────────────────


def test_missing_input_is_unknown():
    failure = classify_stellar_failure()
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "unclassified"


@pytest.mark.parametrize("bad_status", ["500", 500.0, True, False, None, 999, 99, -1])
def test_malformed_status_is_unknown(bad_status):
    failure = classify_stellar_failure(status_code=bad_status)
    assert failure.classification is StellarRetryClass.UNKNOWN


def test_malformed_exception_is_unknown():
    failure = classify_stellar_failure(exc="not an exception")
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "malformed_exception"


@pytest.mark.parametrize(
    "bad_code",
    ["", "1abc", "UPPER!", "has space", "a" * 65, None, 123],
)
def test_malformed_error_code_is_ignored(bad_code):
    failure = classify_stellar_failure(error_code=bad_code)
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "unclassified"


def test_boundary_status_edges():
    assert classify_stellar_failure(status_code=100).classification is StellarRetryClass.UNKNOWN
    assert classify_stellar_failure(status_code=599).classification is StellarRetryClass.UNKNOWN
    assert classify_stellar_failure(status_code=600).classification is StellarRetryClass.UNKNOWN


def test_boundary_error_code_length():
    # 64 characters is the maximum accepted length.
    assert len("a" + "b" * 63) == 64
    failure = classify_stellar_failure(error_code="a" + "b" * 63)
    assert failure.code == "unclassified"
    failure = classify_stellar_failure(error_code="a" + "b" * 64)
    assert failure.code == "unclassified"


# ── classify_stellar_result ────────────────────────────────────────────────────


def test_none_result_is_not_a_failure():
    assert classify_stellar_result(None) is None


def test_success_result_is_not_a_failure():
    assert classify_stellar_result({"status": "submitted", "tx_hash": "abc"}) is None


def test_result_with_empty_error_string_is_not_a_failure():
    assert classify_stellar_result({"error": ""}) is None


def test_malformed_non_dict_result_is_a_failure():
    failure = classify_stellar_result("not a dict")
    assert failure is not None
    assert failure.classification is StellarRetryClass.UNKNOWN
    assert failure.code == "malformed_result"


def test_result_with_error_uses_attached_status_code():
    failure = classify_stellar_result({"error": "nope", "statusCode": 402})
    assert failure.classification is StellarRetryClass.PERMANENT


def test_result_kind_failed_without_error_is_a_failure():
    failure = classify_stellar_result({"status": "failed"})
    assert failure is not None
    assert failure.classification is StellarRetryClass.UNKNOWN


def test_result_honours_attached_classification():
    failure = classify_stellar_result(
        {"failure_class": "retryable", "failure_code": "transport_unavailable"}
    )
    assert failure is not None
    assert failure.classification is StellarRetryClass.RETRYABLE
    assert failure.retryable


def test_result_ignores_unknown_attached_classification():
    # A bogus attached class must not silently become a real failure signal.
    failure = classify_stellar_result({"failure_class": "banana", "status": "failed"})
    assert failure is not None
    assert failure.classification is StellarRetryClass.UNKNOWN


# ── Privacy ────────────────────────────────────────────────────────────────────


def test_message_never_interpolates_exception_text():
    exc = RuntimeError(f"leaked {FAKE_SEED} and {FAKE_PAYMENT_PROOF}")
    failure = classify_stellar_failure(exc=exc)
    assert FAKE_SEED not in failure.message
    assert "leaked" not in failure.message
    assert FAKE_SEED not in repr(failure.to_dict())
    assert FAKE_PAYMENT_PROOF not in str(failure.log_fields())


def test_attach_replaces_raw_error_with_safe_message():
    failure = classify_stellar_failure(status_code=402)
    merged = attach_stellar_failure({"error": f"boom {FAKE_SEED}", "tx": "abc"}, failure)
    assert merged["error"] == failure.message
    assert FAKE_SEED not in merged["error"]
    assert merged["tx"] == "abc"  # unrelated keys preserved
    assert merged["failure_class"] == "permanent"
    assert merged["retryable"] is False
    assert merged["terminal"] is True


def test_attach_accepts_none_result():
    failure = classify_stellar_failure()
    merged = attach_stellar_failure(None, failure)
    assert merged["failure_class"] == "unknown"
    assert "error" in merged


def test_failure_dataclass_is_frozen():
    failure = classify_stellar_failure()
    with pytest.raises(AttributeError):
        failure.code = "other"  # type: ignore[misc]


# ── Integration: StellarKit ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_transfer_xlm_success_shape_is_unchanged():
    api = AsyncMock()
    api.request_transfer = AsyncMock(return_value={"status": "submitted", "tx_hash": "t"})

    kit = StellarKit(api)
    await kit.initialize()
    result = await kit.transfer_xlm("G" + "A" * 55, 10.0)

    assert result["status"] == "submitted"
    assert result["to"] == "G" + "A" * 55
    assert "failure_class" not in result


@pytest.mark.asyncio
async def test_transfer_xlm_api_error_is_classified_and_privacy_safe():
    api = AsyncMock()
    api.request_transfer = AsyncMock(
        return_value={"error": f"denied {FAKE_SEED}", "statusCode": 403}
    )

    kit = StellarKit(api)
    await kit.initialize()
    result = await kit.transfer_xlm("G" + "A" * 55, 10.0)

    assert result["failure_class"] == "permanent"
    assert result["failure_code"] == "unauthorized"
    assert result["retryable"] is False
    assert result["terminal"] is True
    assert FAKE_SEED not in result["error"]


@pytest.mark.asyncio
async def test_transfer_xlm_exception_is_classified_without_leaking():
    api = AsyncMock()
    api.request_transfer = AsyncMock(
        side_effect=httpx.ConnectError(f"refused {FAKE_PAYMENT_PROOF}")
    )

    kit = StellarKit(api)
    await kit.initialize()
    result = await kit.transfer_xlm("G" + "A" * 55, 10.0)

    assert result["failure_class"] == "retryable"
    assert result["retryable"] is True
    assert FAKE_PAYMENT_PROOF not in result["error"]


@pytest.mark.asyncio
async def test_transfer_xlm_timeout_is_indeterminate():
    api = AsyncMock()
    api.request_transfer = AsyncMock(side_effect=httpx.ReadTimeout("timeout"))

    kit = StellarKit(api)
    await kit.initialize()
    result = await kit.transfer_xlm("G" + "A" * 55, 10.0)

    assert result["failure_class"] == "indeterminate"
    assert result["indeterminate"] is True
    assert result["retryable"] is False


@pytest.mark.asyncio
async def test_transfer_xlm_empty_result_is_unknown_failure():
    api = AsyncMock()
    api.request_transfer = AsyncMock(return_value=None)

    kit = StellarKit(api)
    await kit.initialize()
    result = await kit.transfer_xlm("G" + "A" * 55, 10.0)

    assert result["failure_class"] == "unknown"
    assert "error" in result


def test_stellar_failure_to_dict_is_bounded():
    failure = classify_stellar_failure(status_code=503)
    assert isinstance(failure, StellarFailure)
    assert set(failure.to_dict()) == {
        "failure_class",
        "failure_code",
        "retryable",
        "indeterminate",
        "terminal",
    }


# ── Integration: worker lifecycle (loan repayment) ─────────────────────────────

def _make_loan_deps(*, transfer_result):
    from unittest.mock import MagicMock

    settings = MagicMock()
    settings.auto_repay_loans = True
    stellar_kit = MagicMock()
    stellar_kit.initialize = AsyncMock()
    stellar_kit.get_balance = AsyncMock(return_value={"balance_xlm": 100.0})
    api = MagicMock()
    api.request_transfer = AsyncMock(return_value=transfer_result)
    db = MagicMock()
    db.get_loans_due_soon = MagicMock(
        return_value=[
            {
                "id": 7,
                "outstanding_amount": 40.0,
                "loan_asset": "XLM",
                "repayment_address": "G" + "A" * 55,
            }
        ]
    )
    db.add_activity = MagicMock()
    db.update_schedule = MagicMock()
    db.record_repayment = MagicMock()
    return settings, stellar_kit, api, db


@pytest.mark.asyncio
async def test_loan_repayment_surfaces_classified_terminal_failure():
    settings, stellar_kit, api, db = _make_loan_deps(
        transfer_result={
            "error": "denied",
            "failure_class": "permanent",
            "failure_code": "unauthorized",
        }
    )

    result = await run_loan_repayment(
        settings=settings, stellar_kit=stellar_kit, api=api, db=db
    )

    assert result["errors"] == 1
    assert result["failure_classes"] == {"permanent": 1}
    db.record_repayment.assert_not_called()


@pytest.mark.asyncio
async def test_loan_repayment_unclassified_failure_degrades_to_unknown():
    settings, stellar_kit, api, db = _make_loan_deps(
        transfer_result={"error": "denied"}
    )

    result = await run_loan_repayment(
        settings=settings, stellar_kit=stellar_kit, api=api, db=db
    )

    assert result["errors"] == 1
    assert result["failure_classes"] == {"unknown": 1}
    # Legacy activity message is preserved for backward compatibility.
    db.add_activity.assert_any_call(
        "loan_error",
        "Auto-repay failed for loan 7: denied",
        "defi",
    )
