"""Orchestrates a full deterministic replay cycle.

``replay_cycle`` is the single entry-point for both CLI and programmatic use.
It:

1. Loads the recorded events from ``ReplayStore``.
2. Rebuilds ``AgentContext`` from the recorded ``cycle_start`` event.
3. Constructs a ``StubRegistry`` from the recorded ``tool_result`` events.
4. Calls ``run_with_stubs`` to re-execute the LLM decision boundary.
5. Compares original tool-call sequence with replay via ``check_divergence``.
6. Returns a ``ReplayResult`` with the divergence report and structured log.

Version pinning
---------------
The recording stores the ``agent_version`` string in the session row.  If the
running code's ``__version__`` differs from the recorded version, a warning is
included in the result — the operator can decide whether the version gap is
acceptable.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import structlog

from talos_agent import __version__
from talos_agent.replay.capture import ReplayEvent
from talos_agent.replay.divergence import DivergenceReport, check_divergence
from talos_agent.replay.store import ReplayStore
from talos_agent.replay.stubs import StubRegistry, run_with_stubs

log = structlog.get_logger()


@dataclass
class ReplayResult:
    """Result of a replay run."""

    cycle_id: str
    session: dict[str, Any]
    events: list[ReplayEvent]
    divergence: DivergenceReport
    version_warning: str | None = None
    replay_messages: list[dict] = field(default_factory=list)
    error: str | None = None

    @property
    def success(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "cycle_id": self.cycle_id,
            "success": self.success,
            "error": self.error,
            "version_warning": self.version_warning,
            "divergence": self.divergence.to_dict(),
            "event_count": len(self.events),
        }


async def replay_cycle(
    *,
    cycle_id: str,
    store: ReplayStore,
    settings: Any,
    db: Any,
    shutdown_event: asyncio.Event | None = None,
    max_events: int = 1000,
) -> ReplayResult:
    """Replay a recorded agent cycle deterministically.

    Parameters
    ----------
    cycle_id:
        The cycle to replay (must exist in ``replay_sessions``).
    store:
        ``ReplayStore`` connected to the same DB as the original recording.
    settings:
        Agent settings (used for the real LLM call in the decision boundary).
    db:
        ``LocalDB`` instance (read-only during replay — stubs prevent writes).
    shutdown_event:
        Optional asyncio event to abort replay on shutdown.
    max_events:
        Safety cap on loaded events to prevent memory exhaustion.

    Returns
    -------
    ``ReplayResult`` with divergence report, version info, and full message
    trace from the replayed loop.
    """
    log.info("replay_cycle_start", cycle_id=cycle_id)

    # ── 1. Load session metadata ───────────────────────────────────────────
    session = store.get_session(cycle_id)
    if session is None:
        log.error("replay_session_not_found", cycle_id=cycle_id)
        return _error_result(cycle_id, {}, [], "Session not found")

    if session["status"] == "recording":
        return _error_result(cycle_id, session, [], "Session is still recording")

    recorded_version = session.get("agent_version", "")
    version_warning: str | None = None
    if recorded_version and recorded_version != __version__:
        version_warning = (
            f"Version mismatch: recorded={recorded_version!r}, "
            f"running={__version__!r}. "
            "Tool behaviour may differ."
        )
        log.warning("replay_version_mismatch",
                    recorded=recorded_version, running=__version__)

    # ── 2. Load events ────────────────────────────────────────────────────
    events = store.get_events(cycle_id, limit=max_events)
    if not events:
        return _error_result(cycle_id, session, [], "No events found for cycle")

    log.info("replay_events_loaded", cycle_id=cycle_id, count=len(events))

    # ── 3. Rebuild original message trace from recorded events ────────────
    original_messages = _reconstruct_messages(events)

    # ── 4. Rebuild talos_config from session meta ─────────────────────────
    meta = json.loads(session.get("meta", "{}"))
    talos_config = meta.get("talos_config", {"id": session["talos_id"]})

    # ── 5. Build context from recorded cycle_start event ──────────────────
    context = _build_replay_context(events, talos_config, db)

    # ── 6. Build stub registry ─────────────────────────────────────────────
    stubs = StubRegistry.from_events(events)
    log.info("replay_stubs_built",
             cycle_id=cycle_id,
             tool_count=len(stubs.registered_tools))

    # ── 7. Re-execute LLM decision boundary ───────────────────────────────
    replay_messages: list[dict] = []
    error: str | None = None
    try:
        replay_messages = await run_with_stubs(
            settings=settings,
            stub_registry=stubs,
            talos_config=talos_config,
            context=context,
            db=db,
            events=events,
            shutdown_event=shutdown_event,
        )
        log.info("replay_loop_complete",
                 cycle_id=cycle_id,
                 message_count=len(replay_messages))
    except Exception as exc:  # noqa: BLE001
        error = f"Replay loop error: {exc}"
        log.error("replay_loop_error", cycle_id=cycle_id, error=str(exc))

    # ── 8. Divergence report ───────────────────────────────────────────────
    report = check_divergence(cycle_id, original_messages, replay_messages)
    log.info(
        "replay_divergence_check",
        cycle_id=cycle_id,
        has_divergence=report.has_divergence,
        diff_count=len(report.diffs),
    )

    return ReplayResult(
        cycle_id=cycle_id,
        session=session,
        events=events,
        divergence=report,
        version_warning=version_warning,
        replay_messages=replay_messages,
        error=error,
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _error_result(
    cycle_id: str,
    session: dict[str, Any],
    events: list[ReplayEvent],
    error: str,
) -> ReplayResult:
    empty_report = DivergenceReport(
        cycle_id=cycle_id,
        original_tool_calls=[],
        replay_tool_calls=[],
    )
    return ReplayResult(
        cycle_id=cycle_id,
        session=session,
        events=events,
        divergence=empty_report,
        error=error,
    )


def _reconstruct_messages(events: list[ReplayEvent]) -> list[dict]:
    """Rebuild OpenAI-format message list from llm_request / llm_response / tool_result events."""
    messages: list[dict] = []
    for ev in events:
        if ev.kind == "llm_response":
            msg: dict = {"role": "assistant"}
            if ev.payload.get("content"):
                msg["content"] = ev.payload["content"]
            tcs = ev.payload.get("tool_calls", [])
            if tcs:
                msg["tool_calls"] = tcs
            if len(msg) > 1:
                messages.append(msg)
        elif ev.kind == "tool_result":
            tool_name = ev.payload.get("tool_name", "unknown")
            result = ev.payload.get("result", {})
            messages.append({
                "role": "tool",
                "content": json.dumps(result, sort_keys=True, ensure_ascii=False),
                "tool_name": tool_name,
            })
    return messages


def _build_replay_context(
    events: list[ReplayEvent],
    talos_config: dict[str, Any],
    db: Any,
) -> Any:
    """Build an AgentContext for replay.

    We prefer to reconstruct from the live DB state (since the replay is meant
    to validate what the agent *would* do now given the same inputs), but if
    the DB is unavailable we fall back to a minimal context.
    """
    from talos_agent.agent.context import AgentContext
    try:
        return AgentContext.from_db(db, talos_config)
    except Exception:  # noqa: BLE001
        # Minimal fallback context for replay without a live DB
        from datetime import datetime, timezone
        return AgentContext(
            current_time=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            posts_today=0,
            research_today=0,
            replies_today=0,
            pending_approvals=0,
            pending_jobs=0,
            last_agent_cycle="never",
            recent_content=[],
            active_playbook=None,
            talos_config=talos_config,
            spending_today=0.0,
            spending_month=0.0,
            gtm_budget=200.0,
            performance_summary={},
            active_learnings=[],
            audience_insights=[],
            unmeasured_count=0,
        )
