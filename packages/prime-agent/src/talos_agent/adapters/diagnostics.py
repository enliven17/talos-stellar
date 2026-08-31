"""Bounded, redacted schema for adapter structured-log diagnostics."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

MAX_PROVIDER_LENGTH = 64
MAX_OPERATION_LENGTH = 64
MAX_STATUS_LENGTH = 32
MAX_ERROR_LENGTH = 256
MAX_OPERATION_ID_LENGTH = 128
MAX_CAPABILITY_LENGTH = 32
MAX_TARGET_LENGTH = 128
MAX_RESOURCE_LENGTH = 32

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_SAFE_LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
_SENSITIVE_KEY = re.compile(r"(?:token|authorization|secret|api[_-]?key|password|cookie|signature|credential|private[_-]?key|webhook)", re.I)
_INLINE_SECRET = re.compile(r"(Bearer\s+)[^\s,;]+", re.I)
_VALID_OPERATIONS = frozenset({"post", "reply", "get_mentions", "search", "get_post_performance", "get_profile_stats", "network", "browser"})
_VALID_STATUSES = frozenset({"succeeded", "failed", "timed_out", "denied"})
_VALID_CAPABILITIES = frozenset({"secret", "network", "browser", "browser_host", "filesystem_read", "filesystem_write", "tool", "manifest", "operation"})
_VALID_RESOURCES = frozenset({"input", "output", "request", "network_requests", "network_response", "browser_actions"})


def _redact(value: Any, seen: set[int] | None = None) -> Any:
    """Redact sensitive keys recursively before a value is rendered or capped."""
    seen = set() if seen is None else seen
    if isinstance(value, Mapping):
        if id(value) in seen:
            return "[CYCLE]"
        seen.add(id(value))
        return {str(key): "[REDACTED]" if _SENSITIVE_KEY.search(str(key)) else _redact(child, seen) for key, child in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        if id(value) in seen:
            return "[CYCLE]"
        seen.add(id(value))
        return [_redact(child, seen) for child in value]
    return _INLINE_SECRET.sub(r"\1[REDACTED]", value) if isinstance(value, str) else value


def _text(value: Any, maximum: int) -> str:
    """Render a redacted value as one bounded, single-line string."""
    return _CONTROL_CHARS.sub(" ", str(value))[:maximum]


def _label(value: Any, maximum: int, allowed: frozenset[str] | None = None) -> str:
    text = _text(_redact(value), maximum)
    return text if _SAFE_LABEL.fullmatch(text) and (allowed is None or text in allowed) else "unknown"


def safe_adapter_diagnostic_fields(**fields: Any) -> dict[str, Any]:
    """Return only documented, bounded adapter-log fields.

    Unknown fields are dropped. Redaction always occurs before control-character
    replacement and truncation.
    """
    result: dict[str, Any] = {}
    if "adapter" in fields or "provider" in fields:
        result["adapter"] = _label(fields.get("adapter", fields.get("provider")), MAX_PROVIDER_LENGTH)
    if "operation" in fields:
        result["operation"] = _label(fields["operation"], MAX_OPERATION_LENGTH, _VALID_OPERATIONS)
    if fields.get("operation_id") is not None:
        result["operation_id"] = _label(fields["operation_id"], MAX_OPERATION_ID_LENGTH)
    if "outcome" in fields or "status" in fields:
        result["outcome"] = _label(fields.get("outcome", fields.get("status")), MAX_STATUS_LENGTH, _VALID_STATUSES)
    if "error_type" in fields:
        result["error_type"] = _label(fields["error_type"], MAX_ERROR_LENGTH)
    if "error" in fields:
        result["error"] = _text(_redact(fields["error"]), MAX_ERROR_LENGTH)
    if "capability" in fields:
        result["capability"] = _label(fields["capability"], MAX_CAPABILITY_LENGTH, _VALID_CAPABILITIES)
    if "target" in fields:
        result["target"] = _text(_redact(fields["target"]), MAX_TARGET_LENGTH)
    if "resource" in fields:
        result["resource"] = _label(fields["resource"], MAX_RESOURCE_LENGTH, _VALID_RESOURCES)
    duration = fields.get("duration_ms")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        result["duration_ms"] = max(0, min(round(duration, 2), 3_600_000))
    return result
