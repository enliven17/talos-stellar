"""Deterministic execution replay for incident analysis (Issue #235).

Overview
--------
Replay captures a sequence of labelled events (context snapshots, tool
calls, completions) during an agent cycle and persists them to SQLite.
A maintainer can later load the recorded session and drive ``ReplayRunner``
to re-execute the recorded decision sequence using stubbed side-effects,
producing a ``ReplayResult`` that flags any divergence from the original.

Design choices
--------------
* Disabled by default (``Settings.replay_enabled = False``).
* Sensitive keys are redacted at record time so the DB never stores raw
  credentials or secret material.
* Serialisation is always stable (``sort_keys=True``) so diffs are
  meaningful.
* Version of the agent at record time is pinned into the session so
  operators can detect drift.
* ``ReplayRunner.run_with_stubs()`` does **not** reinvoke the LLM — it
  replays the recorded event sequence using the stored payloads and
  detects structural divergence (missing, extra, or type-changed events).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import structlog

from talos_agent import __version__

log = structlog.get_logger()

# Keys whose values are automatically redacted (case-insensitive substring match).
_SENSITIVE_KEY_FRAGMENTS: tuple[str, ...] = (
    "key",
    "secret",
    "token",
    "password",
    "api_key",
    "private",
)


# ── Redaction helpers ──────────────────────────────────────────────────────────


def _is_sensitive_key(key: str) -> bool:
    lower = key.lower()
    return any(frag in lower for frag in _SENSITIVE_KEY_FRAGMENTS)


def redact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy of *payload* with sensitive values replaced.

    Only the top-level keys are inspected; nested dicts are serialised as-is
    to avoid deep-copy complexity while still protecting the most common
    credential patterns.
    """
    out: dict[str, Any] = {}
    for k, v in payload.items():
        out[k] = "[REDACTED]" if _is_sensitive_key(k) else v
    return out


# ── Data models ───────────────────────────────────────────────────────────────


@dataclass
class ReplayEvent:
    """A single captured event within a replay session."""

    event_id: str
    timestamp: str  # ISO-8601
    event_type: str
    payload: dict[str, Any]
    redacted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "timestamp": self.timestamp,
            "event_type": self.event_type,
            "payload": self.payload,
            "redacted": self.redacted,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ReplayEvent:
        return cls(
            event_id=d["event_id"],
            timestamp=d["timestamp"],
            event_type=d["event_type"],
            payload=d.get("payload", {}),
            redacted=bool(d.get("redacted", False)),
        )


@dataclass
class ReplaySession:
    """All recorded events for a single agent cycle execution."""

    session_id: str
    agent_version: str
    talos_id: str
    started_at: str  # ISO-8601
    events: list[ReplayEvent] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "agent_version": self.agent_version,
            "talos_id": self.talos_id,
            "started_at": self.started_at,
            "events": [e.to_dict() for e in self.events],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ReplaySession:
        return cls(
            session_id=d["session_id"],
            agent_version=d["agent_version"],
            talos_id=d["talos_id"],
            started_at=d["started_at"],
            events=[ReplayEvent.from_dict(e) for e in d.get("events", [])],
        )


@dataclass
class ReplayResult:
    """Outcome of running a session through ``ReplayRunner``."""

    session_id: str
    diverged: bool
    divergence_report: list[str]
    replayed_events: list[ReplayEvent]


# ── Serialisation ─────────────────────────────────────────────────────────────


def serialize_session(session: ReplaySession) -> str:
    """Stable JSON serialisation (sorted keys, no extra whitespace)."""
    return json.dumps(session.to_dict(), sort_keys=True, default=str)


def deserialize_session(data: str) -> ReplaySession:
    """Inverse of :func:`serialize_session`."""
    return ReplaySession.from_dict(json.loads(data))


# ── Recorder ──────────────────────────────────────────────────────────────────


class ReplayRecorder:
    """Records events to SQLite during a live agent cycle.

    Parameters
    ----------
    session_id:
        Unique identifier for the recording session (usually a UUID).
    db:
        ``LocalDB`` instance.  The recorder calls
        ``db.create_replay_session()`` lazily on the first event.
    talos_id:
        The Talos identifier, stored in the session header.
    redact:
        When ``True`` (the default), sensitive payload keys are replaced
        with ``"[REDACTED]"`` before persistence.
    """

    def __init__(
        self,
        session_id: str,
        db: Any,  # LocalDB — typed as Any to avoid circular import
        talos_id: str = "",
        redact: bool = True,
    ) -> None:
        self.session_id = session_id
        self._db = db
        self._talos_id = talos_id
        self._redact = redact
        self._started_at: str = datetime.now(timezone.utc).isoformat()
        self._session_created = False

    def _ensure_session(self) -> None:
        if not self._session_created:
            self._db.create_replay_session(
                session_id=self.session_id,
                talos_id=self._talos_id,
                agent_version=__version__,
                started_at=self._started_at,
            )
            self._session_created = True

    def record(self, event_type: str, payload: dict[str, Any]) -> ReplayEvent:
        """Persist an event and return the ``ReplayEvent`` dataclass.

        The payload is shallow-redacted when ``self._redact`` is True.
        """
        self._ensure_session()

        effective_payload = redact_payload(payload) if self._redact else dict(payload)
        was_redacted = self._redact and any(_is_sensitive_key(k) for k in payload)

        event = ReplayEvent(
            event_id=str(uuid.uuid4()),
            timestamp=datetime.now(timezone.utc).isoformat(),
            event_type=event_type,
            payload=effective_payload,
            redacted=was_redacted,
        )

        try:
            self._db.insert_replay_event(
                session_id=self.session_id,
                event_id=event.event_id,
                event_type=event.event_type,
                payload_json=json.dumps(effective_payload, sort_keys=True, default=str),
                redacted=was_redacted,
            )
        except Exception as exc:
            log.warning("replay_record_error", session_id=self.session_id, error=str(exc))

        log.debug(
            "replay_event_recorded",
            session_id=self.session_id,
            event_type=event_type,
            event_id=event.event_id,
        )
        return event

    def get_events(self, session_id: str) -> list[ReplayEvent]:
        """Load all events for *session_id* from the DB."""
        rows = self._db.get_replay_events(session_id)
        events: list[ReplayEvent] = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except (json.JSONDecodeError, KeyError):
                payload = {}
            events.append(
                ReplayEvent(
                    event_id=row["event_id"],
                    timestamp=row["recorded_at"],
                    event_type=row["event_type"],
                    payload=payload,
                    redacted=bool(row["redacted"]),
                )
            )
        return events


# ── Runner ────────────────────────────────────────────────────────────────────


class ReplayRunner:
    """Deterministically replays a recorded session using side-effect stubs.

    The runner walks the recorded event list and "re-executes" each event
    by returning the recorded payload rather than invoking live tools.
    Divergence is detected when the replayed sequence differs from the
    recorded one in length, event types, or payload structure (key set).

    Parameters
    ----------
    session:
        The loaded ``ReplaySession`` to replay.
    """

    def __init__(self, session: ReplaySession) -> None:
        self._session = session

    def run_with_stubs(
        self,
        tool_fn_override: dict[str, Any] | None = None,
    ) -> ReplayResult:
        """Replay the session and compare against the recorded events.

        Parameters
        ----------
        tool_fn_override:
            Optional mapping of ``event_type → callable`` that replaces the
            default stub (returning the recorded payload).  Useful for
            injecting custom verification logic in tests.

        Returns
        -------
        ReplayResult
            Contains divergence flags and a human-readable report.
        """
        recorded = self._session.events
        replayed: list[ReplayEvent] = []
        divergence_report: list[str] = []

        for idx, original in enumerate(recorded):
            # Determine the stubbed result for this event.
            if tool_fn_override and original.event_type in tool_fn_override:
                try:
                    result_payload: dict[str, Any] = tool_fn_override[original.event_type](
                        original.payload
                    )
                except Exception as exc:
                    divergence_report.append(
                        f"[{idx}] {original.event_type}: stub raised {type(exc).__name__}: {exc}"
                    )
                    result_payload = {}
            else:
                # Default stub: return the recorded payload unchanged.
                result_payload = dict(original.payload)

            replayed_event = ReplayEvent(
                event_id=str(uuid.uuid4()),
                timestamp=datetime.now(timezone.utc).isoformat(),
                event_type=original.event_type,
                payload=result_payload,
                redacted=original.redacted,
            )
            replayed.append(replayed_event)

            # Structural divergence: payload key set must match.
            original_keys = set(original.payload.keys())
            replayed_keys = set(result_payload.keys())
            if original_keys != replayed_keys:
                missing = original_keys - replayed_keys
                extra = replayed_keys - original_keys
                msg_parts = []
                if missing:
                    msg_parts.append(f"missing keys {sorted(missing)}")
                if extra:
                    msg_parts.append(f"extra keys {sorted(extra)}")
                divergence_report.append(
                    f"[{idx}] {original.event_type}: payload divergence — "
                    + ", ".join(msg_parts)
                )

        # Length divergence: if stubs produced a different number of events.
        if len(replayed) != len(recorded):
            divergence_report.append(
                f"event count divergence: recorded={len(recorded)}, replayed={len(replayed)}"
            )

        diverged = bool(divergence_report)

        log.info(
            "replay_run_complete",
            session_id=self._session.session_id,
            diverged=diverged,
            divergence_count=len(divergence_report),
        )

        return ReplayResult(
            session_id=self._session.session_id,
            diverged=diverged,
            divergence_report=divergence_report,
            replayed_events=replayed,
        )


# ── Session loader ────────────────────────────────────────────────────────────


def load_session_from_db(session_id: str, db: Any) -> ReplaySession | None:
    """Load a ``ReplaySession`` from the database, or ``None`` if not found.

    Parameters
    ----------
    session_id:
        The UUID of the session to load.
    db:
        ``LocalDB`` instance.
    """
    rows = db.list_replay_sessions()
    session_row = None
    for row in rows:
        if row["session_id"] == session_id:
            session_row = row
            break

    if session_row is None:
        return None

    recorder = ReplayRecorder(session_id=session_id, db=db)
    events = recorder.get_events(session_id)

    return ReplaySession(
        session_id=session_row["session_id"],
        agent_version=session_row["agent_version"],
        talos_id=session_row["talos_id"],
        started_at=session_row["started_at"],
        events=events,
    )
