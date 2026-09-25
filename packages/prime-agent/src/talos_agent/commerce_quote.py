"""Commerce quote expiry enforcement.

Mirrors the SDK ``verifyQuoteNotExpired`` contract for the Prime Agent so
buyers never sign or submit payment against an expired (or malformed) quote.

Expiry semantics (aligned with packages/sdk ``a2a-validation.ts``):
- A quote is valid only while ``now < expires_at`` (boundary instant is expired).
- Nested ``payment_details["quote"]["expiresAt"]`` is preferred; top-level
  ``expiresAt`` / ``expires_at`` are accepted as a compatibility fallback.
- Missing or malformed expiry fails closed with an explicit, privacy-safe error
  (never echoes signatures, seeds, or payment proofs).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from talos_agent.clock import ClockProtocol, SystemClock

# Stable reason codes — keep in sync with SDK ReasonCode where applicable.
EXPIRED_QUOTE = "EXPIRED_QUOTE"
INVALID_QUOTE = "INVALID_QUOTE"
MISSING_QUOTE_EXPIRY = "MISSING_QUOTE_EXPIRY"

_DEFAULT_CLOCK: ClockProtocol = SystemClock()


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


def verify_quote_not_expired(
    expires_at: datetime,
    *,
    now: datetime | None = None,
    clock: ClockProtocol | None = None,
) -> bool:
    """Return True iff the quote is still valid at *now*.

    Matches SDK ``verifyQuoteNotExpired``: valid only while ``now < expires_at``.
    """
    if now is None:
        now = (clock or _DEFAULT_CLOCK).now()
    return _as_utc(now) < _as_utc(expires_at)


def enforce_commerce_quote_expiry(
    payment_details: Mapping[str, Any] | None,
    *,
    now: datetime | None = None,
    clock: ClockProtocol | None = None,
    require_expiry: bool = True,
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

    Returns
    -------
    None
        Quote is present (or not required) and not expired — proceed.
    dict
        Privacy-safe error payload with ``error``, ``code``, and optional
        ``expires_at`` (ISO string only — never signatures or proofs).
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

    if not verify_quote_not_expired(expires_at, now=now, clock=clock):
        return {
            "error": "Commerce quote has expired",
            "code": EXPIRED_QUOTE,
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
        }

    return None


def quote_expiry_iso(payment_details: Mapping[str, Any] | None) -> str | None:
    """Return normalized UTC Zulu expiry string when parseable, else None."""
    raw = extract_quote_expires_at(payment_details)
    dt = parse_iso8601_timestamp(raw)
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")
