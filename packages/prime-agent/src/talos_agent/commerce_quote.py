"""Commerce quote expiry enforcement and the x402 payment clock-skew policy.

Mirrors the SDK ``verifyQuoteNotExpired`` contract for the Prime Agent so
buyers never sign or submit payment against an expired (or malformed) quote.

Expiry semantics (aligned with packages/sdk ``a2a-validation.ts``):
- A quote is valid only while ``now < expires_at`` (boundary instant is expired).
- Nested ``payment_details["quote"]["expiresAt"]`` is preferred; top-level
  ``expiresAt`` / ``expires_at`` are accepted as a compatibility fallback.
- Missing or malformed expiry fails closed with an explicit, privacy-safe error
  (never echoes signatures, seeds, or payment proofs).

x402 payment clock-skew policy
------------------------------
A quote's ``expiresAt`` is stamped by the issuer (Talos Web / the seller), but
the decision to sign is taken by the agent against its *own* clock. Two clocks
that disagree by more than the remaining validity turn a perfectly good quote
into a rejected one — and the reverse failure is worse: a quote with a
sub-second remainder passes the check, the agent signs, and the x402 payment
is already expired by the time the facilitator settles it, burning a nonce and
a budget line for a payment that can never clear.

:class:`X402ClockSkewPolicy` makes that decision explicit and bounded. It is
applied through the existing interface, so it does not introduce a second
source of truth:

- ``max_clock_skew_secs`` — worst-case disagreement tolerated between the agent
  clock and the issuer/facilitator clock, in the only direction that matters
  here (the agent clock may be *ahead*, so the offered deadline is treated as
  reachable a little later than advertised).
- ``min_remaining_validity_secs`` — validity that must remain on top of that
  tolerance so the sign → submit → settle round trip cannot land after expiry.

The two bounds combine into a single comparison against an effective deadline
(``expires_at + max_clock_skew_secs - min_remaining_validity_secs``) rather
than a chain of independent checks, so the verdict stays monotone in time and
no arrival instant can be accepted and rejected at the same moment.

Both helpers keep their current, strict, zero-tolerance behaviour unless a
policy is supplied; :data:`DEFAULT_X402_CLOCK_SKEW_POLICY` is the recommended
policy for callers that take payments (see ``tools/commerce.py``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from talos_agent.clock import ClockProtocol, SystemClock

# Stable reason codes — keep in sync with SDK ReasonCode where applicable.
EXPIRED_QUOTE = "EXPIRED_QUOTE"
INVALID_QUOTE = "INVALID_QUOTE"
MISSING_QUOTE_EXPIRY = "MISSING_QUOTE_EXPIRY"
INSUFFICIENT_VALIDITY = "INSUFFICIENT_VALIDITY"

_DEFAULT_CLOCK: ClockProtocol = SystemClock()


@dataclass(frozen=True)
class X402ClockSkewPolicy:
    """Bounded tolerance for comparing the agent clock to an x402 deadline.

    Parameters
    ----------
    max_clock_skew_secs:
        Largest disagreement tolerated between the agent clock and the
        issuer/facilitator clock before an advertised deadline is treated as
        genuinely passed. Kept small and explicit: this only ever extends the
        window by the amount an operator is willing to assume, never leaves it
        open indefinitely.
    min_remaining_validity_secs:
        Validity that must remain *after* accounting for that disagreement,
        covering the sign → submit → settle round trip. A quote that would
        expire mid-flight is refused before a nonce or a budget line is spent.

        Defaults intentionally exceed ``max_clock_skew_secs`` so the policy is
        net-conservative: it refuses more quotes than the pre-policy strict
        check did, never fewer, unless an operator opts into a wider window.

    Both values are validated on construction so a misconfigured policy fails
    loudly at startup instead of silently disabling the guard.
    """

    max_clock_skew_secs: float = 5.0
    min_remaining_validity_secs: float = 15.0

    def __post_init__(self) -> None:
        for name, value in (
            ("max_clock_skew_secs", self.max_clock_skew_secs),
            ("min_remaining_validity_secs", self.min_remaining_validity_secs),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be a number")
            if not math.isfinite(value):
                raise ValueError(f"{name} must be finite")
            if value < 0:
                raise ValueError(f"{name} must be >= 0")

    def effective_deadline(self, expires_at: datetime) -> datetime:
        """Return the last instant at which signing is still considered safe.

        The advertised deadline is extended by the tolerated skew and pulled
        back by the required settlement margin.
        """
        return _as_utc(expires_at) + timedelta(
            seconds=self.max_clock_skew_secs - self.min_remaining_validity_secs
        )


#: Recommended policy for callers that take x402 payments.
DEFAULT_X402_CLOCK_SKEW_POLICY = X402ClockSkewPolicy()

#: Zero-tolerance policy — byte-for-byte the pre-policy strict comparison.
STRICT_CLOCK_SKEW_POLICY = X402ClockSkewPolicy(
    max_clock_skew_secs=0.0,
    min_remaining_validity_secs=0.0,
)


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_iso8601_timestamp(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp into a timezone-aware UTC datetime.

    Returns ``None`` for missing / empty / unparseable values (fail closed).
    Accepts trailing ``Z`` as UTC.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # Reject obvious non-timestamps early
    if len(text) < 10:
        return None
    normalized = text.replace("Z", "+00:00") if text.endswith("Z") else text
    try:
        dt = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return None
    return _as_utc(dt)


def extract_quote_expires_at(payment_details: Mapping[str, Any] | None) -> object:
    """Return the raw expiry field from a 402 / quote payload.

    Preference order:
    1. ``quote.expiresAt`` / ``quote.expires_at`` (A2A Quote shape)
    2. top-level ``expiresAt`` / ``expires_at``
    """
    if not isinstance(payment_details, Mapping):
        return None
    quote = payment_details.get("quote")
    if isinstance(quote, Mapping):
        for key in ("expiresAt", "expires_at"):
            if key in quote and quote.get(key) is not None:
                return quote.get(key)
    for key in ("expiresAt", "expires_at"):
        if key in payment_details and payment_details.get(key) is not None:
            return payment_details.get(key)
    return None


def _now_utc(now: datetime | None, clock: ClockProtocol | None) -> datetime:
    if now is None:
        now = (clock or _DEFAULT_CLOCK).now()
    return _as_utc(now)


def verify_quote_not_expired(
    expires_at: datetime,
    *,
    now: datetime | None = None,
    clock: ClockProtocol | None = None,
    policy: X402ClockSkewPolicy | None = None,
) -> bool:
    """Return True iff the quote may still be used at *now*.

    With no ``policy`` this is the strict SDK ``verifyQuoteNotExpired``
    contract: valid only while ``now < expires_at``. Supplying a policy swaps
    in its effective deadline, so the answer stays consistent with
    :func:`enforce_commerce_quote_expiry` instead of duplicating the rule.
    """
    deadline = _as_utc(expires_at)
    if policy is not None:
        deadline = policy.effective_deadline(expires_at)
    return _now_utc(now, clock) < deadline


def _expiry_iso(expires_at: datetime) -> str:
    return expires_at.isoformat().replace("+00:00", "Z")


def enforce_commerce_quote_expiry(
    payment_details: Mapping[str, Any] | None,
    *,
    now: datetime | None = None,
    clock: ClockProtocol | None = None,
    require_expiry: bool = True,
    policy: X402ClockSkewPolicy | None = None,
) -> dict[str, Any] | None:
    """Enforce quote expiry on a commerce 402 / quote payload.

    Parameters
    ----------
    payment_details:
        Parsed 402 response body or an A2A-style object that may contain a
        nested ``quote``.
    now / clock:
        Injectable time source for deterministic tests.
    require_expiry:
        When True (default), missing expiry fails closed. When False, a payload
        without any expiry field is allowed through (legacy 402 responses that
        only expose ``price``/``payee``).
    policy:
        Clock-skew tolerance for the payment path. ``None`` (default) keeps the
        original strict comparison — pass
        :data:`DEFAULT_X402_CLOCK_SKEW_POLICY` to apply the settlement margin,
        or :data:`STRICT_CLOCK_SKEW_POLICY` to be explicit about it.

    Returns
    -------
    None
        Quote is present (or not required) and safe to sign — proceed.
    dict
        Privacy-safe error payload with ``error``, ``code``, and optional
        ``expires_at`` (ISO string only — never signatures or proofs).
        ``code`` is one of ``MISSING_QUOTE_EXPIRY``, ``INVALID_QUOTE``,
        ``EXPIRED_QUOTE``, or ``INSUFFICIENT_VALIDITY``.
    """
    raw_expiry = extract_quote_expires_at(payment_details)

    if raw_expiry is None:
        if not require_expiry:
            return None
        # If a nested quote object exists but lacks expiry, that is INVALID;
        # a completely quote-less legacy 402 is MISSING when require_expiry.
        quote = payment_details.get("quote") if isinstance(payment_details, Mapping) else None
        if isinstance(quote, Mapping):
            return {
                "error": "Commerce quote is missing a valid expiresAt timestamp",
                "code": INVALID_QUOTE,
            }
        return {
            "error": "Commerce quote expiry is required before payment",
            "code": MISSING_QUOTE_EXPIRY,
        }

    expires_at = parse_iso8601_timestamp(raw_expiry)
    if expires_at is None:
        return {
            "error": "Commerce quote expiresAt is malformed",
            "code": INVALID_QUOTE,
        }

    now_utc = _now_utc(now, clock)

    if policy is None:
        # Pre-policy strict path: the advertised deadline is authoritative.
        if now_utc < expires_at:
            return None
        return {
            "error": "Commerce quote has expired",
            "code": EXPIRED_QUOTE,
            "expires_at": _expiry_iso(expires_at),
        }

    if now_utc < policy.effective_deadline(expires_at):
        return None

    # Past the effective deadline. Distinguish a quote whose advertised
    # deadline has already gone by from one that is still nominally open but
    # leaves too little room to sign and settle.
    if now_utc >= expires_at:
        return {
            "error": "Commerce quote has expired",
            "code": EXPIRED_QUOTE,
            "expires_at": _expiry_iso(expires_at),
        }
    return {
        "error": "Commerce quote expires too soon to settle payment safely",
        "code": INSUFFICIENT_VALIDITY,
        "expires_at": _expiry_iso(expires_at),
    }


def quote_expiry_iso(payment_details: Mapping[str, Any] | None) -> str | None:
    """Return normalized UTC Zulu expiry string when parseable, else None."""
    raw = extract_quote_expires_at(payment_details)
    dt = parse_iso8601_timestamp(raw)
    if dt is None:
        return None
    return _expiry_iso(dt)
