"""Redaction helpers for values that must never reach agent logs."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_SENSITIVE_KEY_PARTS = frozenset(
    {
        "apikey",
        "authorization",
        "bearertoken",
        "bot_token",
        "encryptedkey",
        "encryptedsecret",
        "paymentheader",
        "paymentproof",
        "paymentsig",
        "paymenttoken",
        "privatekey",
        "secret",
        "secretkey",
        "signature",
        "signedxdr",
        "password",
        "webhookurl",
        "x402",
    }
)

_EXACT_SENSITIVE_KEYS = frozenset({"token", "api_key", "secret", "password"})

_SECRET_PATTERNS = (
    (re.compile(r"(?i)\bBearer\s+[^\s,;]+"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"), "[REDACTED_JWT]"),
    (re.compile(r"\bS[A-Z2-7]{55}\b"), "[REDACTED_STELLAR_SECRET]"),
    (
        re.compile(
            r"(?i)(\b(?:api[_ -]?key|authorization|bearer|encrypted[_ -]?(?:key|secret)|"
            r"payment(?:header|proof|sig|token)|private[_ -]?key|secret(?:[_ -]?key)?|"
            r"signed[_ -]?xdr|password|webhook[_ -]?url)\b\s*[:=]\s*)([^\s,;}]+)"
        ),
        r"\1[REDACTED]",
    ),
)


def _normalise_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def is_sensitive_key(key: object) -> bool:
    key_string = str(key).lower()
    if key_string in _EXACT_SENSITIVE_KEYS:
        return True
    normalised = _normalise_key(str(key))
    return any(part.replace("_", "") in normalised for part in _SENSITIVE_KEY_PARTS)


def redact_text(value: str) -> str:
    """Remove known credential and payment-proof formats from free-form text."""
    for pattern, replacement in _SECRET_PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def redact(value: Any, *, key: object | None = None) -> Any:
    """Return a log-safe copy of mappings, sequences, exceptions, and text."""
    if key is not None and is_sensitive_key(key):
        return "[REDACTED]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, BaseException):
        return redact_text(str(value))
    if isinstance(value, Mapping):
        return {str(item_key): redact(item_value, key=item_key) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact(item) for item in value)
    if isinstance(value, set):
        return {redact(item) for item in value}
    return value


def redact_event(_: Any, __: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """structlog processor that runs immediately before serialization."""
    return redact(event_dict)


def safe_exception_message(error: BaseException) -> str:
    return redact_text(str(error))