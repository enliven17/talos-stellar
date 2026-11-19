"""Centralized log-redaction for the Talos prime-agent.

This module is the **single source of truth** for what counts as sensitive
and how it is masked before any log record, retry message, or exception
summary reaches a sink (stdout JSON, Sentry, metrics).

Design goals
------------
* **Redact before serialize** — the structlog processor installed in
  ``observability.configure_logging()`` applies :func:`redact_event_dict` to
  every structured field *before* :class:`~structlog.processors.JSONRenderer`
  turns the event into a string.  Nothing secret can slip through in a field
  value that was a plain string or nested dict.

* **One pattern set** — all regex and keyword patterns live here.
  ``http.py``, ``routing/fallback.py``, and ``telemetry.py`` import from
  this module instead of maintaining independent copies.

* **Safe fields are preserved** — correlation IDs (``trace_id``,
  ``span_id``, ``job_id``, ``talos_id``), HTTP status codes, error
  categories, transaction hashes, and provider/adapter names are
  **never** redacted.

Safe-to-log field policy
------------------------
See ``docs/LOGGING_POLICY.md`` for the full policy.  A quick reference:

+----------------------------+--------+------------------------------------------+
| Field / pattern            | Action | Rationale                                |
+============================+========+==========================================+
| ``secret_key``             | REDACT | Stellar secret key (S + 55 chars)        |
| Bearer / Token header      | REDACT | OAuth / API bearer tokens                |
| ``x-payment`` / ``x_payment`` | REDACT | x402 payment proof (signed JWT)       |
| ``api_key`` / ``token``    | REDACT | Generic API credentials                  |
| ``password``               | REDACT | Password fields                          |
| ``private_key``            | REDACT | Private key material                     |
| ``authorization``          | REDACT | HTTP Authorization header value          |
| ENC:: envelope prefix      | REDACT | Encrypted-at-rest key material           |
| ``payment_header``         | REDACT | x402 signed payment header               |
+----------------------------+--------+------------------------------------------+
| ``trace_id``, ``span_id``  | KEEP   | Distributed tracing correlation          |
| ``job_id``, ``talos_id``   | KEEP   | Agent / job correlation                  |
| HTTP status codes          | KEEP   | Debugging retries and errors             |
| Transaction hashes         | KEEP   | Stellar on-chain correlation             |
| Provider / adapter names   | KEEP   | Operational diagnostics                  |
| Error type / category      | KEEP   | Structured error routing                 |
| ``payee`` (G… address)     | KEEP   | Public Stellar account ID (G + 55 chars) |
| ``amount``                 | KEEP   | Payment value (not a secret)             |
| ``asset_code``             | KEEP   | Asset symbol (USDC, XLM …)               |
+----------------------------+--------+------------------------------------------+
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

# ---------------------------------------------------------------------------
# Sensitive keyword set — exact matches on lower-cased key names
# ---------------------------------------------------------------------------

#: Keys whose *values* are always redacted, regardless of the context they
#: appear in (structured-log field, JSON response body, exception text …).
REDACT_FIELD_NAMES: frozenset[str] = frozenset(
    {
        # HTTP / API authentication
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "apiKey",
        "authorization",
        "auth",
        "token",
        "secret",
        "password",
        # Cryptographic material
        "private_key",
        "privateKey",
        "private key",
        "stellar_secret",
        "wallet_secret",
        "seed",
        "mnemonic",
        # Payment proofs
        "x-payment",
        "x_payment",
        "payment_header",
        "paymentHeader",
        "payment_proof",
        "proof",
        # Encrypted envelopes
        "encrypted_value",
        "enc_value",
        # Misc
        "signature",
        "signing_key",
    }
)

#: Substrings (lower-cased) that flag a key as sensitive when the exact-match
#: set is not enough (used by :func:`is_sensitive_key`).
_SENSITIVE_SUBSTRINGS: frozenset[str] = frozenset(
    {
        "api_key",
        "api key",
        "apikey",
        "secret",
        "token",
        "password",
        "private_key",
        "private key",
        "signature",
        "stellar_secret",
        "stellar_key",   # covers stellar_key, stellar_signing_key, etc.
        "wallet_secret",
        "wallet_key",
        "signing_key",
        "prompt",
        "user_prompt",
        "system_prompt",
        "seed",
        "mnemonic",
        "payment_proof",
        "proof",
        "payment_header",
        "x-payment",
        "x_payment",
        "x402",
        "authorization",
        "bearer",
        "enc_value",
    }
)

# ---------------------------------------------------------------------------
# Compiled regex patterns for free-text / value scrubbing
# ---------------------------------------------------------------------------

#: Strip C0/C1 control characters to prevent log-injection attacks.
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

#: Bearer / Token scheme in Authorization-style headers or JSON values.
_BEARER_RE = re.compile(
    r"(?i)(Bearer|Token)\s+[A-Za-z0-9\-\._~\+/]+=*"
)

#: Stellar *secret* key — S followed by exactly 55 uppercase Base32 chars.
#: Stellar *public* keys start with G and are safe to log.
#: Note: no \b at the end because Base32 chars are word characters and the
#: boundary fails mid-token when the key appears after = or : without trailing
#: punctuation.  The leading \b (or start-of-string) prevents partial matches
#: on longer tokens, and the negative lookahead prevents matching the start of
#: a longer Base32 string.
_STELLAR_SECRET_RE = re.compile(r"(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])")

#: x402 / EIP-712 payment-header — a base64url JWT-like blob that is long
#: enough to be distinguishable.  Matches both raw base64url tokens and
#: ``"x-payment": "<value>"`` in JSON text.
_X402_PAYMENT_RE = re.compile(
    r"""(?i)(?:x[-_]payment|payment[_-]?header|paymentHeader)["'`]?\s*[:=]\s*["'`]?([A-Za-z0-9\-_\.]+)["'`]?"""
)

#: Key=value pairs for generic credentials in free text.
_KV_CRED_RE = re.compile(
    r"""(?i)(?:api[_-]?key|token|secret|authorization|password|private[_-]?key|x[-_]payment|payment[_-]?header)["'`]?\s*[:=]\s*["'`]?([^"'`\s,;\}]{4,})["'`]?"""
)

#: ENC:: envelope prefix — encrypted-at-rest key material should never appear
#: in plain-text log output.
_ENC_ENVELOPE_RE = re.compile(r"ENC::[A-Za-z0-9+/=]+")

#: Maximum characters kept in any single sanitized string.
LOG_TEXT_MAX_CHARS = 1024

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def is_sensitive_key(key: str) -> bool:
    """Return *True* if *key* looks like it carries sensitive material.

    Checks exact membership in :data:`REDACT_FIELD_NAMES` first (fast path)
    then falls through to substring matching.

    >>> is_sensitive_key("payment_header")
    True
    >>> is_sensitive_key("trace_id")
    False
    """
    lower = key.lower()
    if lower in REDACT_FIELD_NAMES or key in REDACT_FIELD_NAMES:
        return True
    return any(tok in lower for tok in _SENSITIVE_SUBSTRINGS)


def redact_value(value: str) -> str:
    """Apply all regex-based redaction patterns to a free-text *value*.

    Redaction is applied **before** truncation so that a secret straddling
    the truncation boundary is always caught.

    The following are redacted:

    * ``Bearer …`` / ``Token …`` authorization headers
    * Stellar secret keys (``S[A-Z2-7]{55}``)
    * x402 / payment-header values
    * Generic ``key=value`` credential patterns
    * ``ENC::`` envelope blobs

    Safe fields that are preserved:

    * Stellar public keys (``G[A-Z2-7]{55}``) — these are correlation IDs
    * Transaction hashes, job IDs, error messages
    """
    # Normalize unicode and strip control characters to prevent log injection
    text = _CTRL_RE.sub(" ", unicodedata.normalize("NFC", value))

    text = _BEARER_RE.sub("[REDACTED]", text)
    text = _STELLAR_SECRET_RE.sub("[REDACTED]", text)
    text = _ENC_ENVELOPE_RE.sub("[REDACTED]", text)
    text = _X402_PAYMENT_RE.sub(
        lambda m: m.group(0).replace(m.group(1), "[REDACTED]"),
        text,
    )
    text = _KV_CRED_RE.sub(
        lambda m: m.group(0).replace(m.group(1), "[REDACTED]"),
        text,
    )

    if len(text) > LOG_TEXT_MAX_CHARS:
        text = text[: LOG_TEXT_MAX_CHARS - 1] + "…"

    return text


def redact_json_value(value: object) -> object:
    """Recursively redact sensitive keys in a JSON-serialisable structure.

    * ``dict`` — keys in :data:`REDACT_FIELD_NAMES` or matching
      :func:`is_sensitive_key` have their values replaced with
      ``"[REDACTED]"``.
    * ``list`` — each element is recursively processed.
    * ``str`` — passed through :func:`redact_value`.
    * All other scalars are returned as-is.
    """
    if isinstance(value, dict):
        return {
            k: "[REDACTED]" if is_sensitive_key(str(k)) else redact_json_value(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact_json_value(item) for item in value]
    if isinstance(value, str):
        return redact_value(value)
    return value


def redact_text(text: str) -> str:
    """Sanitize a free-text string, attempting JSON parse first.

    If *text* is valid JSON, :func:`redact_json_value` is applied to the
    parsed structure and the result is re-serialized.  Otherwise
    :func:`redact_value` is applied directly.

    This is the function used on HTTP response bodies and exception messages.
    """
    normalized = _CTRL_RE.sub(" ", unicodedata.normalize("NFC", text))
    try:
        payload = json.loads(normalized)
    except Exception:
        return redact_value(normalized)
    sanitized = json.dumps(redact_json_value(payload), ensure_ascii=False)
    # After JSON re-serialization, run value-level patterns on the string
    # output to catch anything that survived structural traversal (e.g. a
    # Stellar secret embedded in a string value).
    sanitized = _BEARER_RE.sub("[REDACTED]", sanitized)
    sanitized = _STELLAR_SECRET_RE.sub("[REDACTED]", sanitized)
    sanitized = _ENC_ENVELOPE_RE.sub("[REDACTED]", sanitized)
    if len(sanitized) > LOG_TEXT_MAX_CHARS:
        sanitized = sanitized[: LOG_TEXT_MAX_CHARS - 1] + "…"
    return sanitized


def redact_event_dict(
    logger: Any,  # noqa: ARG001 — structlog processor signature
    method_name: Any,  # noqa: ARG001
    event_dict: dict[str, Any],
) -> dict[str, Any]:
    """Structlog processor that redacts sensitive fields from every log event.

    Wired into :func:`talos_agent.observability.configure_logging` so that
    **all** ``log.*()`` calls — regardless of which module emits them — are
    sanitized before serialization.

    The ``event`` key (the log message) is passed through :func:`redact_text`
    to catch secrets embedded in free-form log messages.  Every other field
    value is passed through :func:`redact_json_value`.

    Fields that are explicitly safe and left untouched:

    ``trace_id``, ``span_id``, ``job_id``, ``talos_id``,
    ``level``, ``timestamp``, ``logger``, ``_record``
    """
    _SAFE_PASSTHROUGH = frozenset(
        {
            "trace_id",
            "span_id",
            "job_id",
            "talos_id",
            "level",
            "timestamp",
            "logger",
            "_record",
            "event",  # handled separately below
        }
    )

    for key, val in list(event_dict.items()):
        if key in _SAFE_PASSTHROUGH:
            continue
        if is_sensitive_key(key):
            event_dict[key] = "[REDACTED]"
        elif isinstance(val, str):
            event_dict[key] = redact_value(val)
        elif isinstance(val, (dict, list)):
            event_dict[key] = redact_json_value(val)
        # integers, floats, bools, None — safe, leave unchanged

    # Redact the log message itself last so key=value embeds in the message
    # are also caught.
    msg = event_dict.get("event")
    if isinstance(msg, str):
        event_dict["event"] = redact_text(msg)

    return event_dict
