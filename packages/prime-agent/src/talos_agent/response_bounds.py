"""Bound and redact untrusted remote response text before persistence."""

from __future__ import annotations

from talos_agent.redact import redact_text

MAX_REMOTE_ERROR_BODY_BYTES = 4096


def bounded_error_body(value: bytes | bytearray | memoryview | str, maximum: int = MAX_REMOTE_ERROR_BODY_BYTES) -> str:
    """Decode only a bounded byte prefix, then redact and normalize it."""
    if maximum <= 0:
        return ""
    if isinstance(value, (bytes, bytearray, memoryview)):
        text = bytes(value)[:maximum].decode("utf-8", errors="replace")
    else:
        text = str(value).encode("utf-8", errors="replace")[:maximum].decode("utf-8", errors="replace")
    return redact_text(text)[:maximum]


__all__ = ["MAX_REMOTE_ERROR_BODY_BYTES", "bounded_error_body"]
