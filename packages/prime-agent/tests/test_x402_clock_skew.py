"""Focused tests for the x402 payment clock-skew policy.

Covers the policy contract itself (validation, effective deadline), the
positive / negative / boundary verdicts on :func:`enforce_commerce_quote_expiry`,
the monotonicity guarantee that makes a single-comparison policy safe, and the
regression guarantee that omitting a policy keeps the original strict behaviour.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from talos_agent.clock import FakeClock
from talos_agent.commerce_quote import (
    DEFAULT_X402_CLOCK_SKEW_POLICY,
    EXPIRED_QUOTE,
    INSUFFICIENT_VALIDITY,
    INVALID_QUOTE,
    MISSING_QUOTE_EXPIRY,
    STRICT_CLOCK_SKEW_POLICY,
    X402ClockSkewPolicy,
    enforce_commerce_quote_expiry,
    verify_quote_not_expired,
)

FIXED_NOW = datetime(2026, 6, 15, 12, 0, 0, tzinfo=timezone.utc)


def _iso(offset_secs: float) -> str:
    """ISO-8601 timestamp *offset_secs* away from FIXED_NOW."""
    dt = FIXED_NOW + timedelta(seconds=offset_secs)
    return dt.isoformat().replace("+00:00", "Z")


def _quote(offset_secs: float) -> dict:
    return {"quote": {"amount": "1.000000", "expiresAt": _iso(offset_secs)}}


def _enforce(payment_details: dict, *, policy=None, clock=None) -> dict | None:
    return enforce_commerce_quote_expiry(
        payment_details,
        clock=clock or FakeClock(FIXED_NOW),
        policy=policy,
    )


class TestPolicyConstruction:
    def test_defaults_are_net_conservative(self):
        policy = X402ClockSkewPolicy()
        # The settlement margin must dominate the tolerated skew, so the policy
        # can only ever refuse more quotes than the strict check — never fewer.
        assert policy.min_remaining_validity_secs >= policy.max_clock_skew_secs
        assert DEFAULT_X402_CLOCK_SKEW_POLICY == policy

    def test_default_is_stricter_than_zero_tolerance(self):
        default = DEFAULT_X402_CLOCK_SKEW_POLICY.effective_deadline(FIXED_NOW)
        strict = STRICT_CLOCK_SKEW_POLICY.effective_deadline(FIXED_NOW)
        assert default < strict

    @pytest.mark.parametrize("value", [-1, -0.5])
    def test_negative_skew_rejected(self, value):
        with pytest.raises(ValueError, match="max_clock_skew_secs"):
            X402ClockSkewPolicy(max_clock_skew_secs=value)

    @pytest.mark.parametrize("value", [-1, -0.5])
    def test_negative_margin_rejected(self, value):
        with pytest.raises(ValueError, match="min_remaining_validity_secs"):
            X402ClockSkewPolicy(min_remaining_validity_secs=value)

    @pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
    def test_non_finite_rejected(self, value):
        with pytest.raises(ValueError, match="finite"):
            X402ClockSkewPolicy(max_clock_skew_secs=value)

    def test_non_numeric_rejected(self):
        with pytest.raises(ValueError, match="number"):
            X402ClockSkewPolicy(max_clock_skew_secs="30")  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="number"):
            X402ClockSkewPolicy(max_clock_skew_secs=True)  # type: ignore[arg-type]

    def test_policy_is_immutable(self):
        with pytest.raises(Exception):
            DEFAULT_X402_CLOCK_SKEW_POLICY.max_clock_skew_secs = 999  # type: ignore[misc]

    def test_effective_deadline_shifts_by_skew_minus_margin(self):
        policy = X402ClockSkewPolicy(max_clock_skew_secs=30.0, min_remaining_validity_secs=0.0)
        assert policy.effective_deadline(FIXED_NOW) == FIXED_NOW + timedelta(seconds=30)

        policy = X402ClockSkewPolicy(max_clock_skew_secs=0.0, min_remaining_validity_secs=15.0)
        assert policy.effective_deadline(FIXED_NOW) == FIXED_NOW - timedelta(seconds=15)

    def test_naive_deadline_normalized_to_utc(self):
        policy = X402ClockSkewPolicy(max_clock_skew_secs=10.0, min_remaining_validity_secs=0.0)
        naive = datetime(2026, 6, 15, 12, 0, 0)
        assert policy.effective_deadline(naive) == FIXED_NOW + timedelta(seconds=10)


class TestVerifyQuoteNotExpiredPolicy:
    def test_no_policy_is_the_strict_sdk_contract(self):
        clock = FakeClock(FIXED_NOW)
        assert verify_quote_not_expired(FIXED_NOW + timedelta(seconds=1), clock=clock)
        assert not verify_quote_not_expired(FIXED_NOW, clock=clock)
        assert not verify_quote_not_expired(FIXED_NOW - timedelta(seconds=1), clock=clock)

    def test_strict_policy_matches_no_policy(self):
        clock = FakeClock(FIXED_NOW)
        for offset in (-3600, -1, 0, 1, 3600):
            expires = FIXED_NOW + timedelta(seconds=offset)
            assert verify_quote_not_expired(expires, clock=clock) == verify_quote_not_expired(
                expires, clock=clock, policy=STRICT_CLOCK_SKEW_POLICY
            )

    @pytest.mark.parametrize(
        "remaining,expected",
        [
            (3600, True),  # comfortably inside the window
            (10, False),  # exactly at the effective deadline — rejected
            (10.5, True),  # just inside
            (1, False),  # too little validity to settle
            (-1, False),  # already past the advertised deadline
        ],
    )
    def test_default_policy_enforces_the_settlement_margin(self, remaining, expected):
        clock = FakeClock(FIXED_NOW)
        expires = FIXED_NOW + timedelta(seconds=remaining)
        assert (
            verify_quote_not_expired(expires, clock=clock, policy=DEFAULT_X402_CLOCK_SKEW_POLICY)
            is expected
        )

    def test_tolerant_policy_reaches_past_the_advertised_deadline(self):
        clock = FakeClock(FIXED_NOW)
        policy = X402ClockSkewPolicy(max_clock_skew_secs=30.0, min_remaining_validity_secs=0.0)
        # An agent clock running ahead must not reject a quote the issuer still
        # considers open.
        assert verify_quote_not_expired(
            FIXED_NOW - timedelta(seconds=1), clock=clock, policy=policy
        )
        assert not verify_quote_not_expired(
            FIXED_NOW - timedelta(seconds=30), clock=clock, policy=policy
        )


class TestEnforceCommerceQuoteExpiryUnchanged:
    """Omitting ``policy`` must reproduce the pre-policy verdict exactly."""

    @pytest.mark.parametrize("offset", [-3600, -1, 0, 1, 3600])
    def test_strict_policy_matches_no_policy(self, offset):
        details = _quote(offset)
        assert _enforce(details) == _enforce(details, policy=STRICT_CLOCK_SKEW_POLICY)

    def test_boundary_instant_is_still_rejected(self):
        err = _enforce(_quote(0))
        assert err is not None
        assert err["code"] == EXPIRED_QUOTE

    def test_malformed_and_missing_are_unchanged_with_a_policy(self):
        assert _enforce({"quote": {"expiresAt": "soon"}}, policy=DEFAULT_X402_CLOCK_SKEW_POLICY)[
            "code"
        ] == INVALID_QUOTE
        assert _enforce({"quote": {"amount": "1"}}, policy=DEFAULT_X402_CLOCK_SKEW_POLICY)[
            "code"
        ] == INVALID_QUOTE
        assert _enforce({"price": 1.0}, policy=DEFAULT_X402_CLOCK_SKEW_POLICY)[
            "code"
        ] == MISSING_QUOTE_EXPIRY
        assert (
            enforce_commerce_quote_expiry(
                {"price": 1.0},
                clock=FakeClock(FIXED_NOW),
                require_expiry=False,
                policy=DEFAULT_X402_CLOCK_SKEW_POLICY,
            )
            is None
        )


class TestEnforceCommerceQuoteExpiryWithPolicy:
    def test_healthy_quote_accepted(self):
        assert _enforce(_quote(3600), policy=DEFAULT_X402_CLOCK_SKEW_POLICY) is None

    def test_long_expired_quote_rejected(self):
        err = _enforce(_quote(-3600), policy=DEFAULT_X402_CLOCK_SKEW_POLICY)
        assert err["code"] == EXPIRED_QUOTE

    def test_quote_with_sub_second_remainder_is_refused_before_signing(self):
        err = _enforce(_quote(0.2), policy=DEFAULT_X402_CLOCK_SKEW_POLICY)
        assert err is not None
        assert err["code"] == INSUFFICIENT_VALIDITY
        assert err["expires_at"] == _iso(0.2)

    @pytest.mark.parametrize(
        "remaining,code",
        [
            (3600, None),
            (10.5, None),
            (10, INSUFFICIENT_VALIDITY),  # boundary instant of the effective deadline
            (5, INSUFFICIENT_VALIDITY),
            (1, INSUFFICIENT_VALIDITY),  # would expire during sign → submit
            (0.001, INSUFFICIENT_VALIDITY),
            (0, EXPIRED_QUOTE),
            (-1, EXPIRED_QUOTE),
        ],
    )
    def test_verdict_boundaries(self, remaining, code):
        err = _enforce(_quote(remaining), policy=DEFAULT_X402_CLOCK_SKEW_POLICY)
        assert err is None if code is None else err["code"] == code

    def test_tolerant_policy_absorbs_a_skewed_ahead_clock(self):
        policy = X402ClockSkewPolicy(max_clock_skew_secs=30.0, min_remaining_validity_secs=0.0)
        assert _enforce(_quote(-10), policy=policy) is None
        assert _enforce(_quote(-30), policy=policy)["code"] == EXPIRED_QUOTE

    def test_verdict_is_monotone_in_time(self):
        """Later arrival instants must never become acceptable again."""
        policy = DEFAULT_X402_CLOCK_SKEW_POLICY
        codes = []
        for offset in range(-120, 121):
            clock = FakeClock(FIXED_NOW + timedelta(seconds=offset))
            err = _enforce(_quote(0), policy=policy, clock=clock)
            codes.append(None if err is None else err["code"])

        first_error = next(i for i, c in enumerate(codes) if c is not None)
        assert all(c is not None for c in codes[first_error:]), codes
        # ...and the reason escalates from "too tight" to "expired", never back.
        assert INSUFFICIENT_VALIDITY in codes[first_error:]
        assert codes[-1] == EXPIRED_QUOTE

    def test_error_payload_is_privacy_safe(self):
        details = {
            "quote": {"amount": "1.000000", "expiresAt": _iso(-3600)},
            "signature": "0xdeadbeef",
            "payment_proof": "secret-proof",
        }
        err = _enforce(details, policy=DEFAULT_X402_CLOCK_SKEW_POLICY)
        assert set(err) == {"error", "code", "expires_at"}
        assert "0xdeadbeef" not in str(err)
        assert "secret-proof" not in str(err)

    def test_naive_now_is_treated_as_utc(self):
        err = enforce_commerce_quote_expiry(
            _quote(-3600),
            now=datetime(2026, 6, 15, 12, 0, 0),
            policy=DEFAULT_X402_CLOCK_SKEW_POLICY,
        )
        assert err["code"] == EXPIRED_QUOTE
