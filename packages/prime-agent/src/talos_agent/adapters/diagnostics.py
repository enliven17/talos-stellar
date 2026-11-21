"""Bounded, redacted schema for adapter structured-log diagnostics."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

MAX_PROVIDER_LENGTH = 64
MAX_ACCOUNT_LENGTH = 64
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
_VALID_OPERATIONS = frozenset({"post", "reply", "get_mentions", "search", "get_post_performance", "get_profile_stats", "network", "browser", "reload_preview", "recovery_disposition"})
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
    redacted = _redact(value)
    raw_text = str(redacted)
    if len(raw_text) > maximum:
        return "unknown"
    text = _text(redacted, maximum)
    return text if _SAFE_LABEL.fullmatch(text) and (allowed is None or text in allowed) else "unknown"


def safe_adapter_diagnostic_fields(**fields: Any) -> dict[str, Any]:
    """Return only documented, bounded adapter-log fields.

    Unknown fields are dropped. Redaction always occurs before control-character
    replacement and truncation.
    """
    result: dict[str, Any] = {}
    if "adapter" in fields or "provider" in fields:
        provider_val = fields.get("adapter") if fields.get("adapter") is not None else fields.get("provider")
        result["adapter"] = _label(provider_val, MAX_PROVIDER_LENGTH)
    account_val = fields.get("account") if fields.get("account") is not None else fields.get("remote_account")
    if account_val is None:
        account_val = fields.get("account_id")
    if account_val is not None:
        result["account"] = _label(account_val, MAX_ACCOUNT_LENGTH)
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
    if "valid" in fields and isinstance(fields["valid"], bool):
        result["valid"] = fields["valid"]
    if "has_changes" in fields and isinstance(fields["has_changes"], bool):
        result["has_changes"] = fields["has_changes"]
    if "added_channels" in fields and isinstance(fields["added_channels"], (list, tuple, set, frozenset)):
        result["added_channels"] = [_label(c, MAX_PROVIDER_LENGTH) for c in fields["added_channels"]][:32]
    if "removed_channels" in fields and isinstance(fields["removed_channels"], (list, tuple, set, frozenset)):
        result["removed_channels"] = [_label(c, MAX_PROVIDER_LENGTH) for c in fields["removed_channels"]][:32]
    if "modified_channels" in fields and isinstance(fields["modified_channels"], (list, tuple, set, frozenset)):
        result["modified_channels"] = [_label(c, MAX_PROVIDER_LENGTH) for c in fields["modified_channels"]][:32]
    if "affected_scheduled_tasks" in fields and isinstance(fields["affected_scheduled_tasks"], (list, tuple, set, frozenset)):
        result["affected_scheduled_tasks"] = [_label(t, MAX_OPERATION_LENGTH) for t in fields["affected_scheduled_tasks"]][:32]
    if "disposition" in fields:
        result["disposition"] = _label(fields["disposition"], MAX_STATUS_LENGTH)
    if "action" in fields:
        result["action"] = _label(fields["action"], MAX_OPERATION_LENGTH)
    if "safe_actions" in fields and isinstance(fields["safe_actions"], (list, tuple, set, frozenset)):
        result["safe_actions"] = [_label(a, MAX_OPERATION_LENGTH) for a in fields["safe_actions"]][:32]
    if "uncertain_count" in fields and isinstance(fields["uncertain_count"], int) and not isinstance(fields["uncertain_count"], bool):
        result["uncertain_count"] = max(0, min(fields["uncertain_count"], 1_000_000))
    return result


# ── Publication intent reconciliation (#1458) ────────────────────────────────
#
# Runs at startup, before any new publish is attempted. Reads every ``pending``
# intent from the store, asks the transport what it knows about each, and
# writes the outcome back. The three possible outcomes mirror
# ``PublicationIntentStatus``: ``confirmed`` (transport has it), ``rejected``
# (transport refused it), ``unknown`` (no answer within the reconcile window —
# HELD forever, never auto-resent).
#
# This is additive: ``safe_adapter_diagnostic_fields`` and its constants are
# unchanged, and no existing diagnostic output shape is modified.

def reconcile_pending_intents(
    *,
    intent_store: "PublicationIntentStore",
    transport_lookup,  # Callable[[str], str | None]
    now_iso: str | None = None,
    max_age_seconds: int = 15 * 60,
) -> dict[str, int]:
    """Reconcile every ``pending`` publication intent against the transport.

    Parameters
    ----------
    intent_store:
        The :class:`PublicationIntentStore` to read from and write back to.
    transport_lookup:
        Called once per pending intent with its ``action_id``. Returns
        ``"confirmed"`` / ``"rejected"`` if the transport has a definitive
        answer, ``None`` if it does not (yet).
    now_iso:
        Current time as ISO string; defaults to UTC now. Provided so tests can
        assert the ``resolved_at`` field deterministically.
    max_age_seconds:
        Pending intents older than this with no transport answer are marked
        ``unknown``. Held forever, never auto-resent.

    Returns
    -------
    dict[str, int]
        Counts by final status — ``{"confirmed": N, "rejected": N, "unknown": N,
        "still_pending": N}``. Does not include intents that were already
        ``confirmed`` or ``rejected`` before this call.
    """
    from datetime import datetime, timezone

    from talos_agent.adapters.publication_intent import PublicationIntentStatus

    now_iso = now_iso or datetime.now(timezone.utc).isoformat(timespec="microseconds")
    now = datetime.fromisoformat(now_iso)
    counts = {"confirmed": 0, "rejected": 0, "unknown": 0, "still_pending": 0}

    for intent in intent_store.list_by_status(PublicationIntentStatus.PENDING):
        answer = transport_lookup(intent.action_id)
        if answer == "confirmed":
            intent.status = PublicationIntentStatus.CONFIRMED
            intent.resolved_at = now_iso
            intent_store.write(intent)
            counts["confirmed"] += 1
            continue
        if answer == "rejected":
            intent.status = PublicationIntentStatus.REJECTED
            intent.resolved_at = now_iso
            intent.last_error = intent.last_error or "transport reported rejection"
            intent_store.write(intent)
            counts["rejected"] += 1
            continue

        # No definitive answer. Past the window → unknown (held); inside → leave
        # pending so a later pass can reconcile again.
        try:
            created = datetime.fromisoformat(intent.created_at)
        except ValueError:
            created = now
        age = (now - created).total_seconds()
        if age >= max_age_seconds:
            intent.status = PublicationIntentStatus.UNKNOWN
            intent.resolved_at = now_iso
            intent.last_error = "reconcile window elapsed with no transport answer"
            intent_store.write(intent)
            counts["unknown"] += 1
        else:
            counts["still_pending"] += 1

    return counts
