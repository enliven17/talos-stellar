"""Internal tools — local DB queries for agent context."""

from __future__ import annotations

from typing import TYPE_CHECKING

from talos_agent.tools.registry import tool

if TYPE_CHECKING:
    from talos_agent.db import LocalDB

# Injected by registry.build_all_tools
_db: LocalDB = None  # type: ignore[assignment]


@tool("get_content_history", "Get recent content history to avoid duplicate posts")
async def get_content_history(limit: int = 10) -> dict:
    rows = _db.get_recent_content(limit)
    return {"history": rows}


@tool("get_schedule_status", "Get today's activity counts and last run times")
async def get_schedule_status() -> dict:
    return {
        "posts_today": _db.count_today("post"),
        "research_today": _db.count_today("research"),
        "replies_today": _db.count_today("reply"),
        "last_agent_cycle": str(_db.get_last_run("agent_cycle") or "never"),
    }


@tool("save_research_notes", "Save research findings to local DB for future reference")
async def save_research_notes(notes: str, channel: str = "research") -> dict:
    _db.add_activity("research", notes, channel)
    return {"status": "saved"}


@tool("get_active_playbook", "Get the currently active GTM playbook strategy")
async def get_active_playbook() -> dict:
    playbook = _db.get_active_playbook()
    if playbook:
        return playbook
    return {"status": "no_active_playbook"}


@tool("record_post", "Record a posted content to prevent duplicates")
async def record_post(content: str, channel: str) -> dict:
    _db.add_content(content, channel)
    _db.add_activity("post", content, channel)
    return {"status": "recorded"}
