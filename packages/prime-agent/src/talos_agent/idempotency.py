"""Idempotency key utilities for the Talos prime-agent.

Keys are RFC 4122 v4 UUIDs — globally unique, opaque, and free of PII.
They are scoped per talosId on the server so the same UUID is safe to reuse
across different agents.
"""

from __future__ import annotations

import re
import uuid

IDEMPOTENCY_KEY_MAX_BYTES: int = 128

_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def generate_idempotency_key() -> str:
    """Generate a new idempotency key as a UUID v4 string.

    Uses :func:`uuid.uuid4`, which draws from the OS CSPRNG
    (``/dev/urandom`` on Linux, ``CryptGenRandom`` on Windows).
    """
    return str(uuid.uuid4())


def validate_idempotency_key(key: str) -> str:
    """Validate a caller-supplied idempotency key.

    Raises :class:`ValueError` if the key is empty or exceeds
    ``IDEMPOTENCY_KEY_MAX_BYTES`` bytes when UTF-8 encoded.

    Returns the key unchanged on success.
    """
    if not isinstance(key, str) or not key.strip():
        raise ValueError("idempotency_key must be a non-empty string")
    byte_length = len(key.encode("utf-8"))
    if byte_length > IDEMPOTENCY_KEY_MAX_BYTES:
        raise ValueError(
            f"idempotency_key must be at most {IDEMPOTENCY_KEY_MAX_BYTES} bytes "
            f"(got {byte_length})"
        )
    return key


def is_uuid_v4(key: str) -> bool:
    """Return True if *key* is a well-formed RFC 4122 v4 UUID.

    Non-UUID keys are also valid — this function is informational only.
    """
    return bool(_UUID_V4_RE.match(key))


def is_payload_conflict(body: str) -> bool:
    """Return True if the response body indicates a payload-conflict 409.

    A payload-conflict means the key was reused with a different payload (a
    caller error). In-flight duplicates also return 409 but have different
    wording and should be retried with the same key.
    """
    return "different payload" in body.lower()


class IdempotencyConflictError(Exception):
    """Raised when a write call returns 409 due to key reuse with a different payload.

    This is a caller error — the caller should generate a new key for the
    new request.  It is *not* retryable.
    """

    def __init__(self, key: str, path: str, body: str) -> None:
        self.key = key
        self.path = path
        self.body = body
        super().__init__(
            f'Idempotency key "{key}" was reused with a different payload on {path}. '
            f"Generate a new key for a different request. Server said: {body}"
        )
