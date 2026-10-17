"""Classify Stellar transaction retry failures.

Every failure that can surface while an agent submits a Stellar transaction
(transfer, dividend distribution, loan repayment) is mapped to exactly one
:class:`StellarRetryClass`.  The classification is the single source of truth
that the payment proxy, the tools, and the worker lifecycle all consume, so
operators get a predictable answer to *"should this be retried?"* instead of
re-implementing heuristics per call site.

Design rules
------------
* **Bounded input.** Only an HTTP status code, an exception *type*, or an
  explicitly supplied bounded ``error_code`` influence the result.  Free-form
  server text is never parsed, so a malicious or noisy upstream cannot steer
  the classification.
* **Privacy-safe output.** ``message`` is chosen from a fixed per-class table —
  it never interpolates exception text, response bodies, seeds, payment
  proofs, or any other sensitive material.
* **Aligned retry policy.** ``retryable`` mirrors
  :data:`talos_agent.http.RETRYABLE_STATUSES` so a class of ``retryable`` or
  ``rate_limited`` means exactly "safe to feed back into the existing bounded
  retry loop".

The module intentionally has no dependencies on the scheduler or durable job
code; those layers import *this* module and map the result onto their own
state machines.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any

import httpx

from talos_agent.circuit_breaker import CircuitBreakerOpen
from talos_agent.http import RETRYABLE_STATUSES, RetryableHTTPError

# Bounded machine-code shape, matching the durable job-effect convention.
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class StellarRetryClass(str, Enum):
    """Explicit classification of a Stellar transaction retry failure."""

    RETRYABLE = "retryable"
    """Transient dependency failure (transport error, upstream 5xx). Retry."""

    RATE_LIMITED = "rate_limited"
    """Upstream throttling (429). Retry after the advertised backoff."""

    INDETERMINATE = "indeterminate"
    """Timed out after submission — the outcome is unknown. Reconcile first."""

    PERMANENT = "permanent"
    """Terminal failure (bad request, auth, insufficient funds, conflict)."""

    UNKNOWN = "unknown"
    """Malformed or unclassifiable input; treat as non-retryable by default."""


#: Constant, privacy-safe messages — one per class.
_MESSAGES: dict[StellarRetryClass, str] = {
    StellarRetryClass.RETRYABLE: (
        "Stellar transaction failed with a transient error; safe to retry with backoff."
    ),
    StellarRetryClass.RATE_LIMITED: (
        "Stellar transaction was rate limited; retry after the advertised backoff."
    ),
    StellarRetryClass.INDETERMINATE: (
        "Stellar transaction outcome is unknown after a timeout; reconcile before retrying."
    ),
    StellarRetryClass.PERMANENT: (
        "Stellar transaction failed permanently; do not retry without changing the inputs."
    ),
    StellarRetryClass.UNKNOWN: (
        "Stellar transaction failed with an unclassified error; operator review required."
    ),
}

# Explicit upstream error codes we are willing to interpret.  Anything outside
# these sets stays ``unknown`` rather than being echoed back to callers.
_PERMANENT_ERROR_CODES = frozenset(
    {
        "insufficient_funds",
        "tx_insufficient_balance",
        "tx_insufficient_fee",
        "invalid_destination",
        "destination_required",
        "no_destination",
        "unauthorized",
        "forbidden",
        "invalid_signature",
        "tx_bad_auth",
        "tx_bad_seq",
        "conflict",
        "not_found",
        "invalid_request",
        "bad_request",
        "payment_required",
    }
)
_RETRYABLE_ERROR_CODES = frozenset(
    {
        "transport_error",
        "transport_unavailable",
        "upstream_unavailable",
        "service_unavailable",
        "circuit_open",
        "server_error",
    }
)
_RATE_LIMIT_ERROR_CODES = frozenset({"rate_limited", "too_many_requests"})
_INDETERMINATE_ERROR_CODES = frozenset(
    {"submission_timeout", "dispatch_timeout", "timeout"}
)


@dataclass(frozen=True)
class StellarFailure:
    """A classified Stellar transaction retry failure.

    The dataclass carries no request payload, address, signature, or exception
    text — it is safe to log, return from a tool, or persist.
    """

    classification: StellarRetryClass
    code: str
    message: str

    @property
    def retryable(self) -> bool:
        """True when the bounded retry loop may safely try again."""
        return self.classification in (
            StellarRetryClass.RETRYABLE,
            StellarRetryClass.RATE_LIMITED,
        )

    @property
    def indeterminate(self) -> bool:
        """True when the transaction may have landed and must be reconciled."""
        return self.classification is StellarRetryClass.INDETERMINATE

    @property
    def terminal(self) -> bool:
        """True when retrying without changing the inputs is pointless."""
        return self.classification is StellarRetryClass.PERMANENT

    def to_dict(self) -> dict[str, Any]:
        """Bounded, privacy-safe projection for tool results and logs."""
        return {
            "failure_class": self.classification.value,
            "failure_code": self.code,
            "retryable": self.retryable,
            "indeterminate": self.indeterminate,
            "terminal": self.terminal,
        }

    def log_fields(self) -> dict[str, Any]:
        """Alias for :meth:`to_dict` used by structured log call sites."""
        return self.to_dict()


def _failure(classification: StellarRetryClass, code: str) -> StellarFailure:
    return StellarFailure(
        classification=classification,
        code=code,
        message=_MESSAGES[classification],
    )


def _coerce_status(status_code: object) -> int | None:
    """Return a valid HTTP status int, or ``None`` for missing/malformed input."""
    if isinstance(status_code, bool) or not isinstance(status_code, int):
        return None
    if 100 <= status_code <= 599:
        return status_code
    return None


def _classify_error_code(error_code: object) -> StellarFailure | None:
    """Classify an explicitly supplied, bounded upstream error code."""
    if not isinstance(error_code, str):
        return None
    code = error_code.strip().lower()
    if not _ERROR_CODE_RE.fullmatch(code):
        return None
    if code in _PERMANENT_ERROR_CODES:
        return _failure(StellarRetryClass.PERMANENT, code)
    if code in _RATE_LIMIT_ERROR_CODES:
        return _failure(StellarRetryClass.RATE_LIMITED, code)
    if code in _INDETERMINATE_ERROR_CODES:
        return _failure(StellarRetryClass.INDETERMINATE, code)
    if code in _RETRYABLE_ERROR_CODES:
        return _failure(StellarRetryClass.RETRYABLE, code)
    return None


def classify_stellar_failure(
    *,
    status_code: object = None,
    exc: BaseException | object = None,
    error_code: object = None,
) -> StellarFailure:
    """Classify a Stellar transaction retry failure.

    Parameters
    ----------
    status_code:
        HTTP status observed for the failure. Non-int, out-of-range, and
        boolean values are treated as missing.
    exc:
        The exception that aborted the transaction, if any. Only the
        exception *type* is inspected — the message is never read.
    error_code:
        An optional bounded upstream code (``[a-z][a-z0-9_]{0,63}``). Only
        codes in the known sets are interpreted; anything else is ignored.

    Returns
    -------
    StellarFailure
        A classification that is always populated, even for missing or
        malformed input (``unknown`` / ``unclassified``).
    """
    # An explicit, recognized code is the most specific signal.
    if error_code is not None:
        classified = _classify_error_code(error_code)
        if classified is not None:
            return classified

    if exc is not None:
        if isinstance(exc, CircuitBreakerOpen):
            # The request never left the process — safe to retry once the
            # circuit closes.
            return _failure(StellarRetryClass.RETRYABLE, "circuit_open")
        if isinstance(exc, RetryableHTTPError):
            # Exhausted the retry loop on a retryable status; use the status.
            if status_code is None:
                status_code = exc.status_code
        elif isinstance(exc, (httpx.TimeoutException, TimeoutError, asyncio.TimeoutError)):
            # Submitted but never confirmed — may have executed on chain.
            return _failure(StellarRetryClass.INDETERMINATE, "submission_timeout")
        elif isinstance(exc, httpx.TransportError):
            # Connection/read/write failure before a response was seen.
            return _failure(StellarRetryClass.RETRYABLE, "transport_unavailable")
        elif not isinstance(exc, BaseException):
            # Malformed caller input (not an exception at all).
            return _failure(StellarRetryClass.UNKNOWN, "malformed_exception")
        else:
            return _failure(StellarRetryClass.UNKNOWN, "unclassified")

    status = _coerce_status(status_code)
    if status is None:
        # Missing/unusable status and no exception type to lean on.
        return _failure(StellarRetryClass.UNKNOWN, "unclassified")

    if status == 429:
        return _failure(StellarRetryClass.RATE_LIMITED, "rate_limited")
    if status in RETRYABLE_STATUSES:
        return _failure(StellarRetryClass.RETRYABLE, "upstream_unavailable")
    if status in (401, 403):
        return _failure(StellarRetryClass.PERMANENT, "unauthorized")
    if status == 402:
        return _failure(StellarRetryClass.PERMANENT, "insufficient_funds")
    if status == 404:
        return _failure(StellarRetryClass.PERMANENT, "not_found")
    if status == 409:
        return _failure(StellarRetryClass.PERMANENT, "conflict")
    if 400 <= status < 500:
        return _failure(StellarRetryClass.PERMANENT, "invalid_request")
    if 500 <= status < 600:
        # Not in the bounded retry set; surface it without promising a retry.
        return _failure(StellarRetryClass.UNKNOWN, "server_error")
    return _failure(StellarRetryClass.UNKNOWN, "unclassified")


def classify_stellar_result(result: object) -> StellarFailure | None:
    """Classify a Web API transfer/result payload.

    Returns ``None`` when *result* represents success (or an already-classified
    payload), otherwise a :class:`StellarFailure`.  Server-provided text is
    never copied into the classification.
    """
    if result is None:
        return None
    if not isinstance(result, dict):
        # A malformed (non-object) result is still a failure worth surfacing.
        return _failure(StellarRetryClass.UNKNOWN, "malformed_result")

    # Prefer an explicit classification already attached at the API boundary.
    attached = result.get("failure_class")
    if isinstance(attached, str):
        try:
            classification = StellarRetryClass(attached)
        except ValueError:
            classification = None
        if classification is not None:
            code = result.get("failure_code")
            if not (isinstance(code, str) and _ERROR_CODE_RE.fullmatch(code)):
                code = "unclassified"
            return StellarFailure(classification, code, _MESSAGES[classification])

    status = result.get("status")
    is_failed = bool(result.get("error")) or status in ("failed", "error")
    if not is_failed:
        return None

    return classify_stellar_failure(
        status_code=result.get("statusCode", result.get("status_code")),
        error_code=result.get("code", result.get("errorCode")),
    )


def attach_stellar_failure(
    result: dict[str, Any] | None, failure: StellarFailure
) -> dict[str, Any]:
    """Return *result* with the classification fields merged in (additive).

    Existing keys are preserved except ``error``, which is replaced with the
    privacy-safe classification message when the payload is a failure. Callers
    that only check ``"error" in result`` keep working unchanged.
    """
    merged: dict[str, Any] = dict(result) if isinstance(result, dict) else {}
    merged["error"] = failure.message
    merged.update(failure.to_dict())
    return merged


__all__ = [
    "StellarFailure",
    "StellarRetryClass",
    "attach_stellar_failure",
    "classify_stellar_failure",
    "classify_stellar_result",
]
