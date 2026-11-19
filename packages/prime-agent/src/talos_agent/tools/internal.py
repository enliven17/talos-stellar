"""Internal tools — local DB queries for agent context."""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.tools import context as _context
from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.config import Settings
    from talos_agent.db import LocalDB

# Injected by registry.build_all_tools
_db: LocalDB = None  # type: ignore[assignment]
_settings: Settings = None  # type: ignore[assignment]


def _content_history_max_limit() -> int:
    """Resolve the configured hard cap, falling back to a safe default."""
    if _settings is not None:
        try:
            return int(_settings.content_history_max_limit)
        except (AttributeError, TypeError, ValueError):
            pass
    return 50


def _research_notes_max_bytes() -> int:
    """Resolve the configured note size budget, falling back to a safe default."""
    if _settings is not None:
        try:
            return int(_settings.research_notes_max_bytes)
        except (AttributeError, TypeError, ValueError):
            pass
    return 4096


def _clamp_limit(limit: int, max_limit: int) -> int:
    """Clamp an LLM-provided limit to [1, max_limit]."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 10
    limit = max(limit, 1)
    limit = min(limit, max_limit)
    return limit


def _truncate_notes(notes: str, max_bytes: int) -> str:
    """Truncate notes to max_bytes (UTF-8), recording when truncation occurs."""
    if not isinstance(notes, str):
        notes = str(notes) if notes is not None else ""
    encoded = notes.encode("utf-8")
    if len(encoded) <= max_bytes:
        return notes
    # Truncate at a UTF-8 boundary so we never emit a partial codepoint.
    truncated = encoded[:max_bytes].decode("utf-8", errors="ignore")
    marker = "\n[truncated: note exceeded size budget]"
    # Make sure the marker fits inside the budget after truncation.
    if len(truncated.encode("utf-8")) + len(marker.encode("utf-8")) > max_bytes:
        # Shrink truncated so marker fits.
        budget = max_bytes - len(marker.encode("utf-8"))
        if budget < 0:
            return marker
        truncated = encoded[:budget].decode("utf-8", errors="ignore")
    return truncated + marker


def _deps():
    """This agent's dependencies: the bound ToolContext, else this module's globals."""
    return _context.resolve(globals())


@tool("get_content_history", "Get recent content history to avoid duplicate posts")
async def get_content_history(limit: int = 10) -> dict:
    rows = _deps().db.get_recent_content(limit)
    return {"history": rows}


@tool("get_schedule_status", "Get today's activity counts and last run times")
async def get_schedule_status() -> dict:
    return {
        "posts_today": _deps().db.count_today("post"),
        "research_today": _deps().db.count_today("research"),
        "replies_today": _deps().db.count_today("reply"),
        "last_agent_cycle": str(_deps().db.get_last_run("agent_cycle") or "never"),
    }


@tool("save_research_notes", "Save research findings to local DB for future reference")
async def save_research_notes(notes: str, channel: str = "research") -> dict:
    _deps().db.add_activity("research", notes, channel)
    return {"status": "saved"}


@tool("get_active_playbook", "Get the currently active GTM playbook strategy")
async def get_active_playbook() -> dict:
    playbook = _deps().db.get_active_playbook()
    if playbook:
        return playbook
    return {"status": "no_active_playbook"}


@tool("record_post", "Record a posted content to prevent duplicates")
async def record_post(content: str, channel: str) -> dict:
    _deps().db.add_content(content, channel)
    _deps().db.add_activity("post", content, channel)
    return {"status": "recorded"}
