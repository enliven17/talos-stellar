"""Adapter diagnostics — pause control and in-flight outcome reporting.

An operator can pause publications for a single adapter without touching any
other adapter in the registry.  Sends that were already in-flight when the
pause was issued are tracked so that callers can observe their outcomes.

Usage
-----
Pause an adapter and inspect in-flight outcomes::

    from talos_agent.adapters.diagnostics import AdapterPauseController

    controller = AdapterPauseController()
    controller.pause("discord")

    # Record a send that was already in progress when the pause was set
    controller.record_in_flight("discord", send_id="abc123")

    # Later, mark it resolved
    controller.resolve_in_flight("discord", send_id="abc123", outcome="posted")

    report = controller.in_flight_report("discord")
    # {"paused": True, "in_flight": [{"send_id": "abc123", "outcome": "posted"}]}

Pause states
------------
running  — publications proceed normally.
paused   — new publish calls should be suppressed; prior sends may still land.
"""

from __future__ import annotations

import datetime
import enum
from dataclasses import dataclass, field
from typing import Literal


# ── Pause state ──────────────────────────────────────────────────────────────


class PauseState(str, enum.Enum):
    """Operational state of a single adapter's publication pipeline."""

    RUNNING = "running"
    PAUSED = "paused"


# ── In-flight record ──────────────────────────────────────────���──────────────


@dataclass
class InFlightRecord:
    """Tracks a single send that was started before or during a pause."""

    send_id: str
    """Caller-supplied identifier for this send (e.g. a job or message ID)."""

    started_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )
    """UTC timestamp of when the send was recorded."""

    outcome: str | None = None
    """Final outcome once known: ``"posted"``, ``"failed"``, or ``"pending"``."""

    resolved_at: datetime.datetime | None = None
    """UTC timestamp set when :meth:`AdapterPauseController.resolve_in_flight` is called."""

    def to_dict(self) -> dict:
        d: dict = {
            "send_id": self.send_id,
            "started_at": self.started_at.isoformat(),
            "outcome": self.outcome,
        }
        if self.resolved_at is not None:
            d["resolved_at"] = self.resolved_at.isoformat()
        return d


# ── Pause report ─────────────────────────────────────────────────────────────


@dataclass
class PauseReport:
    """Snapshot of one adapter's pause state and its unresolved in-flight sends."""

    adapter: str
    """Canonical adapter name (case-insensitive normalised to lower-case)."""

    paused: bool
    """``True`` when new publications are suppressed."""

    in_flight: list[InFlightRecord] = field(default_factory=list)
    """All tracked sends, including resolved ones."""

    generated_at: datetime.datetime = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc)
    )

    def to_dict(self) -> dict:
        return {
            "adapter": self.adapter,
            "paused": self.paused,
            "in_flight": [r.to_dict() for r in self.in_flight],
            "generated_at": self.generated_at.isoformat(),
        }


# ── Controller ───────────────────────────────────────────────────────────────


class AdapterPauseController:
    """Manages per-adapter pause state and in-flight outcome tracking.

    All operations are synchronous and in-process only — no I/O is performed.
    Thread safety is left to the caller; the agent loop is single-threaded.
    """

    def __init__(self) -> None:
        self._states: dict[str, PauseState] = {}
        self._in_flight: dict[str, dict[str, InFlightRecord]] = {}

    # ── Pause control ────────────────────────────────────────

    def pause(self, adapter: str) -> None:
        """Pause new publications for *adapter*.

        Unrelated adapters are not affected.  Calling pause on an already-paused
        adapter is a no-op.
        """
        self._states[adapter.lower()] = PauseState.PAUSED

    def resume(self, adapter: str) -> None:
        """Resume publications for *adapter*."""
        self._states[adapter.lower()] = PauseState.RUNNING

    def is_paused(self, adapter: str) -> bool:
        """Return ``True`` if *adapter* is currently paused."""
        return self._states.get(adapter.lower()) == PauseState.PAUSED

    def state(self, adapter: str) -> PauseState:
        """Return the current :class:`PauseState` for *adapter*."""
        return self._states.get(adapter.lower(), PauseState.RUNNING)

    def all_states(self) -> dict[str, str]:
        """Return a mapping of adapter name → state value for every tracked adapter."""
        return {name: s.value for name, s in self._states.items()}

    # ── In-flight tracking ───────────────────────────────────

    def record_in_flight(self, adapter: str, send_id: str) -> InFlightRecord:
        """Record a send that was started when the adapter may be pausing.

        Parameters
        ----------
        adapter:
            Canonical adapter name (case-insensitive).
        send_id:
            Caller-supplied identifier for this send.  Must be unique per adapter.

        Returns
        -------
        InFlightRecord
            The newly created record.
        """
        key = adapter.lower()
        if key not in self._in_flight:
            self._in_flight[key] = {}
        record = InFlightRecord(send_id=send_id)
        self._in_flight[key][send_id] = record
        return record

    def resolve_in_flight(
        self,
        adapter: str,
        send_id: str,
        outcome: Literal["posted", "failed", "pending"],
    ) -> InFlightRecord | None:
        """Set the final outcome for a previously recorded in-flight send.

        Returns the updated :class:`InFlightRecord`, or ``None`` if *send_id*
        was never registered for *adapter*.
        """
        key = adapter.lower()
        record = self._in_flight.get(key, {}).get(send_id)
        if record is None:
            return None
        record.outcome = outcome
        record.resolved_at = datetime.datetime.now(datetime.timezone.utc)
        return record

    def in_flight_report(self, adapter: str) -> PauseReport:
        """Return a :class:`PauseReport` for *adapter*.

        The report includes every tracked in-flight record (resolved or not)
        and the current pause state.  Adapters with no registered in-flight
        sends return an empty list.
        """
        key = adapter.lower()
        records = list(self._in_flight.get(key, {}).values())
        return PauseReport(
            adapter=key,
            paused=self.is_paused(key),
            in_flight=records,
        )

    def uncertain_sends(self, adapter: str) -> list[InFlightRecord]:
        """Return in-flight records whose outcome has not been resolved yet.

        These are sends that were in-progress when a pause was issued and whose
        final delivery status is still unknown.
        """
        key = adapter.lower()
        return [r for r in self._in_flight.get(key, {}).values() if r.outcome is None]
