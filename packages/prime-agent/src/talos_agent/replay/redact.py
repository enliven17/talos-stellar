"""Recursive redaction of sensitive values from arbitrary data structures.

Design goals
------------
* **Recursive**: walks nested dicts, lists, tuples, and sets to any depth.
* **Key-based**: redacts the *value* of any mapping key that matches a
  known-secret pattern (case-insensitive, substring match).
* **Value-based**: redacts any string scalar that looks like a Stellar secret
  key (S… 56-char base32) or a common token format (Bearer …, ENC::…).
* **Bounded depth**: stops at ``max_depth`` (default 64) to prevent stack
  overflow on pathological inputs.
* **Type-preserving**: the redacted placeholder is always the string
  ``"[REDACTED]"``; the surrounding structure is preserved so callers can
  still reason about shape.
* **Idempotent**: calling redact on already-redacted data is a no-op.

Sensitive key fragments (case-insensitive substring match):
  api_key, secret, password, token, credential, private_key, mnemonic,
  seed, auth, bearer, master_key, enc_key, hmac_key, signing_key,
  passphrase, webhook
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"

# ── Patterns that mark a mapping *key* as sensitive ──────────────────────────
_SENSITIVE_KEY_FRAGMENTS: frozenset[str] = frozenset(
    {
        "api_key",
        "secret",
        "password",
        "token",
        "credential",
        "private_key",
        "mnemonic",
        "seed",
        "auth",
        "bearer",
        "master_key",
        "enc_key",
        "hmac_key",
        "signing_key",
        "passphrase",
        "webhook",
        "apikey",
        "accesskey",
        "access_key",
        "secretkey",
        "secret_key",
        "client_secret",
        "client_id",
        "refresh_token",
        "id_token",
        "session",
        "cookie",
        "authorization",
    }
)

# ── Patterns that mark a *value* as sensitive regardless of key ───────────────
# Stellar secret key: starts with S, 56 chars, base32
_STELLAR_SECRET_RE = re.compile(r"^S[A-Z2-7]{55}$")
# ENC:: wrapper used by talos crypto module
_ENC_PREFIX = "ENC::"
# JWT tokens  (header.payload.sig)
_JWT_RE = re.compile(r"^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
# Bearer / Basic auth header values
_BEARER_RE = re.compile(r"^(Bearer|Basic|Token)\s+\S+$", re.IGNORECASE)
# Long hex strings that look like API keys / secrets (≥ 32 hex chars)
_HEX_SECRET_RE = re.compile(r"^[0-9a-fA-F]{32,}$")
# Generic high-entropy base64 blobs (≥ 32 chars, likely a secret)
_B64_SECRET_RE = re.compile(r"^[A-Za-z0-9+/]{32,}={0,2}$")
# Talos API key prefix
_TALOS_KEY_RE = re.compile(r"^(tak|cpk)_[A-Za-z0-9_-]{8,}$", re.IGNORECASE)


def _key_is_sensitive(key: str) -> bool:
    """Return True if a mapping key name indicates a secret value."""
    if not isinstance(key, str):
        return False
    low = key.lower()
    return any(frag in low for frag in _SENSITIVE_KEY_FRAGMENTS)


def _value_is_sensitive(value: str) -> bool:
    """Return True if a string value looks like a secret on its own."""
    if not isinstance(value, str):
        return False
    if value == REDACTED:
        return False  # already redacted – idempotent
    if _STELLAR_SECRET_RE.match(value):
        return True
    if value.startswith(_ENC_PREFIX):
        return True
    if _JWT_RE.match(value):
        return True
    if _BEARER_RE.match(value):
        return True
    if _TALOS_KEY_RE.match(value):
        return True
    # Avoid false-positives on short hex / base64 (config IDs, colours, etc.)
    return len(value) >= 40 and bool(_HEX_SECRET_RE.match(value))


def redact(
    data: Any,
    *,
    _depth: int = 0,
    max_depth: int = 64,
    _parent_key_sensitive: bool = False,
) -> Any:
    """Recursively redact sensitive values from *data*.

    Parameters
    ----------
    data:
        Arbitrary Python value to sanitise.
    max_depth:
        Maximum recursion depth.  Raises ``ValueError`` when exceeded.
    _depth / _parent_key_sensitive:
        Internal recursion state — callers should not pass these.

    Returns
    -------
    A new object of the same type (or a string replacement) with sensitive
    content replaced by ``REDACTED``.
    """
    if _depth > max_depth:
        raise ValueError(
            f"redact(): data structure exceeds max_depth={max_depth}; "
            "possible circular reference or malicious input"
        )

    # ── scalars ──────────────────────────────────────────────────────────────
    if data is None or isinstance(data, (bool, int, float)):
        # Numeric / boolean scalars cannot carry secrets on their own; if the
        # parent key was sensitive we still redact to avoid leaking e.g. a
        # numeric API version that reveals key age.
        return REDACTED if _parent_key_sensitive else data

    if isinstance(data, (bytes, bytearray)):
        return REDACTED if _parent_key_sensitive else data

    if isinstance(data, str):
        if _parent_key_sensitive:
            return REDACTED
        if _value_is_sensitive(data):
            return REDACTED
        return data

    # ── mapping ───────────────────────────────────────────────────────────────
    if isinstance(data, dict):
        out: dict = {}
        for k, v in data.items():
            sensitive = _key_is_sensitive(k)
            out[k] = redact(
                v,
                _depth=_depth + 1,
                max_depth=max_depth,
                _parent_key_sensitive=sensitive,
            )
        return out

    # ── sequences ─────────────────────────────────────────────────────────────
    if isinstance(data, list):
        return [
            redact(item, _depth=_depth + 1, max_depth=max_depth,
                   _parent_key_sensitive=_parent_key_sensitive)
            for item in data
        ]

    if isinstance(data, tuple):
        return tuple(
            redact(item, _depth=_depth + 1, max_depth=max_depth,
                   _parent_key_sensitive=_parent_key_sensitive)
            for item in data
        )

    if isinstance(data, (set, frozenset)):
        redacted_set = {
            redact(item, _depth=_depth + 1, max_depth=max_depth,
                   _parent_key_sensitive=_parent_key_sensitive)
            for item in data
        }
        return type(data)(redacted_set)

    # ── unknown types — convert to repr string ────────────────────────────────
    # This is a safe fallback; sensitive objects that reach here will be
    # represented as their repr, which is unlikely to leak structured secrets
    # but might include the class name.  Callers should register known types
    # explicitly before passing to redact().
    return repr(data)
