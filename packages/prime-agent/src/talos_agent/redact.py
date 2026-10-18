"""Public redaction surface for talos-agent.

All redaction logic used by logs, telemetry, tracing, and diagnostics is
consolidated here.  Internal modules (http, tracing, replay, telemetry,
adapters/diagnostics) implement the details; this module re-exports the
stable, test-facing API so property tests and external callers can import
from a single location.

Functions
---------
redact_text(text)
    Sanitize arbitrary text: scrubs Bearer/Token headers, Stellar secret
    seeds, JSON fields with secret-named keys, and ``key=value`` patterns
    for known credential names.  The canonical redaction function used by
    the HTTP retry layer and the fallback chain.

redact_dict(payload)
    Shallow-redact a dict, replacing values whose key name contains a
    sensitive token with ``"[REDACTED]"``.  Used by the replay recorder.

redact_attributes(attributes)
    Drop secret-keyed entries from a span-attribute mapping and coerce /
    truncate the rest to safe scalar types.  Used by the tracing layer.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# ── re-export canonical implementations ───────────────────────────────────────

from talos_agent.http import _sanitize_response_text as redact_text  # noqa: F401
from talos_agent.replay import redact_payload as redact_dict  # noqa: F401
from talos_agent.tracing import redact_attributes  # noqa: F401

__all__ = [
    "redact_text",
    "redact_dict",
    "redact_attributes",
]
