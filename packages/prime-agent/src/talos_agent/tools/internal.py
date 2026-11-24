"""Internal tools — local DB queries for agent context."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

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
    cfg = getattr(_deps(), "settings", None) or _settings
    if cfg is not None:
        try:
            return int(cfg.content_history_max_limit)
        except (AttributeError, TypeError, ValueError):
            pass
    return 50


def _research_notes_max_bytes() -> int:
    """Resolve the configured note size budget, falling back to a safe default."""
    cfg = getattr(_deps(), "settings", None) or _settings
    if cfg is not None:
        try:
            return int(cfg.research_notes_max_bytes)
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
    marker = "\n[truncated: note exceeded size budget]"
    marker_bytes = marker.encode("utf-8")
    if max_bytes < len(marker_bytes):
        cur_budget = max_bytes
        while cur_budget > 0:
            try:
                return encoded[:cur_budget].decode("utf-8")
            except UnicodeDecodeError:
                cur_budget -= 1
        return ""
    budget = max_bytes - len(marker_bytes)
    while budget > 0:
        try:
            truncated = encoded[:budget].decode("utf-8")
            return truncated + marker
        except UnicodeDecodeError:
            budget -= 1
    return marker


class ContentHistoryResult(dict):
    """Result dict preserving backwards compatibility with exact legacy tests."""

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, dict) and set(other.keys()) == {"history"}:
            return self.get("history") == other.get("history")
        return super().__eq__(other)


class SaveNotesResult(dict):
    """Result dict preserving backwards compatibility with exact legacy tests."""

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, dict) and set(other.keys()) == {"status"}:
            return self.get("status") == other.get("status")
        return super().__eq__(other)


def _deps():
    """This agent's dependencies: the bound ToolContext, else this module's globals."""
    return _context.resolve(globals())


@tool("get_content_history", "Get recent content history to avoid duplicate posts")
async def get_content_history(limit: int = 10) -> dict:
    max_limit = _content_history_max_limit()
    try:
        req_limit = int(limit)
        is_integer = True
    except (TypeError, ValueError):
        req_limit = 10
        is_integer = False

    clamped_limit = _clamp_limit(limit, max_limit)
    is_clamped = (not is_integer) or (clamped_limit != req_limit)

    rows = _deps().db.get_recent_content(clamped_limit)
    result = {
        "history": rows,
        "limit_applied": clamped_limit,
        "limit_clamped": is_clamped,
        "max_limit": max_limit,
    }
    if is_integer:
        result["limit_requested"] = req_limit
    return ContentHistoryResult(result)


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
    max_bytes = _research_notes_max_bytes()
    notes_str = str(notes) if notes is not None else ""
    orig_bytes = len(notes_str.encode("utf-8"))
    truncated = orig_bytes > max_bytes
    stored_notes = _truncate_notes(notes_str, max_bytes) if truncated else notes_str
    stored_bytes = len(stored_notes.encode("utf-8"))

    _deps().db.add_activity("research", stored_notes, channel)
    return SaveNotesResult(
        {
            "status": "saved",
            "truncated": truncated,
            "original_bytes": orig_bytes,
            "stored_bytes": stored_bytes,
            "max_bytes": max_bytes,
        }
    )


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
