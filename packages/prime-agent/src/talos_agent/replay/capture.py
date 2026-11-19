"""Event capture and stable serialization for deterministic replay.

Each captured event represents one external interaction during an agent cycle:
an LLM call, a tool call, or the final agent decision.  Events are serialized
to stable JSON (sorted keys, no floats that differ across Python versions) and
stored alongside the originating cycle_id.

Resource limits
---------------
* ``max_events``    – max events per capture session (default 500).
* ``max_payload_bytes`` – max JSON byte size per event payload (default 64 KB).
  Payloads over the limit are replaced with a truncation sentinel so replay
  can still reconstruct the *shape* of the conversation.

Thread / coroutine safety
--------------------------
``EventCapture`` is not shared across concurrent agent cycles.  Each cycle
creates its own instance.  The ``ReplayStore`` is the shared serialization
boundary and uses SQLite WAL mode (already configured by LocalDB).
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from talos_agent.replay.redact import redact

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_MAX_EVENTS = 500
DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024  # 64 KB
_TRUNCATION_SENTINEL = {"__truncated__": True, "reason": "payload_too_large"}


# ── Data model ────────────────────────────────────────────────────────────────

EventKind = Literal["llm_request", "llm_response", "tool_call", "tool_result", "cycle_start", "cycle_end"]


@dataclass
class ReplayEvent:
    """A single captured event in an agent cycle."""

    event_id: str
    cycle_id: str
    seq: int
    kind: EventKind
    ts: str
    payload: dict[str, Any]

    # ── Serialization ──────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ReplayEvent:
        return cls(**d)

    def stable_json(self) -> str:
        """Return deterministic JSON with sorted keys, no trailing whitespace."""
        return json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False, default=_json_default)


def _json_default(obj: Any) -> Any:
    """JSON serializer fallback for non-standard types."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, (set, frozenset)):
        return sorted(str(x) for x in obj)
    if isinstance(obj, bytes):
        return obj.hex()
    return repr(obj)


# ── Capture configuration ─────────────────────────────────────────────────────

@dataclass
class CaptureConfig:
    max_events: int = DEFAULT_MAX_EVENTS
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES
    enabled: bool = True
    redact_payloads: bool = True


# ── Event capture session ─────────────────────────────────────────────────────

class EventCapture:
    """Collects events for one agent cycle.

    Usage::

        cap = EventCapture(cycle_id="abc-123", config=CaptureConfig())
        cap.record("llm_request", {"model": "llama-3.3", "messages": [...]})
        ...
        events = cap.events  # list[ReplayEvent]
    """

    def __init__(self, cycle_id: str, config: CaptureConfig | None = None) -> None:
        self.cycle_id = cycle_id
        self.config = config or CaptureConfig()
        self._events: list[ReplayEvent] = []
        self._seq = 0
        self._dropped = 0

    # ── Public API ──────────────────────────────────────────────────────────

    @property
    def events(self) -> list[ReplayEvent]:
        return list(self._events)

    @property
    def dropped(self) -> int:
        """Number of events silently dropped due to resource limits."""
        return self._dropped

    def record(self, kind: EventKind, payload: dict[str, Any]) -> ReplayEvent | None:
        """Record an event, applying redaction and size limits.

        Returns the created ``ReplayEvent`` or ``None`` if the capture is full.
        """
        if not self.config.enabled:
            return None

        if len(self._events) >= self.config.max_events:
            self._dropped += 1
            return None

        if self.config.redact_payloads:
            try:
                payload = redact(payload)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001
                # Redaction failure is never fatal — fall back to empty payload
                payload = {"__redaction_error__": True}

        # Enforce per-event payload size limit
        try:
            raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=_json_default)
            if len(raw.encode()) > self.config.max_payload_bytes:
                payload = dict(_TRUNCATION_SENTINEL)
        except (TypeError, ValueError):
            payload = {"__serialize_error__": True}

        event = ReplayEvent(
            event_id=str(uuid.uuid4()),
            cycle_id=self.cycle_id,
            seq=self._seq,
            kind=kind,
            ts=datetime.now(timezone.utc).isoformat(),
            payload=payload,
        )
        self._events.append(event)
        self._seq += 1
        return event

    def record_cycle_start(self, talos_name: str, agent_version: str) -> None:
        self.record("cycle_start", {
            "talos_name": talos_name,
            "agent_version": agent_version,
            "wall_time": time.time(),
        })

    def record_cycle_end(self, outcome: str, iterations: int) -> None:
        self.record("cycle_end", {
            "outcome": outcome,
            "iterations": iterations,
            "wall_time": time.time(),
            "dropped_events": self._dropped,
        })

    def record_llm_request(self, model: str, messages: list[dict], tools: list[dict] | None) -> None:
        self.record("llm_request", {
            "model": model,
            "message_count": len(messages),
            "tool_count": len(tools) if tools else 0,
            # Store messages but not the full tool schemas (too large / not needed for replay)
            "messages": messages,
        })

    def record_llm_response(self, content: str | None, tool_calls: list[dict] | None) -> None:
        self.record("llm_response", {
            "content": content,
            "tool_calls": tool_calls or [],
        })

    def record_tool_call(self, tool_name: str, args: dict) -> None:
        self.record("tool_call", {
            "tool_name": tool_name,
            "args": args,
        })

    def record_tool_result(self, tool_name: str, result: Any) -> None:
        payload: dict[str, Any] = {
            "tool_name": tool_name,
        }
        # Wrap non-dict results
        if isinstance(result, dict):
            payload["result"] = result
        else:
            payload["result"] = {"value": result}
        self.record("tool_result", payload)
